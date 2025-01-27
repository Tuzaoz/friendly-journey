import express from 'express';
import { Twilio } from 'twilio';

import { ImageAnnotatorClient } from '@google-cloud/vision';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import path from 'path';
import pdf from 'pdf-parse';
import { convertToJsonPrompt } from './utils/corvertToJsonPrompt';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
const prisma = new PrismaClient();
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const port = process.env.PORT || 3000;

// Configuração dos clientes
const visionClient = new ImageAnnotatorClient({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
});

const twilioClient = new Twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Renomeie a função para propósito genérico
async function downloadFile(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID!,
      password: process.env.TWILIO_AUTH_TOKEN!,
    },
  });
  return Buffer.from(response.data, 'binary');
}

// Função para extrair texto de PDFs textuais
async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  try {
    const data = await pdf(buffer);
    return data.text;
  } catch (error) {
    throw new Error('Falha ao extrair texto do PDF');
  }
}
async function processTextWithAI(text: string): Promise<string> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `Analise o texto extraído de um documento financeiro (pode ser de um PDF) e identifique:
1. Valor total (R$)
2. Data (DD/MM/AAAA)
3. Estabelecimento/Nome do favorecido
4. Tipo de despesa (Alimentação, Transporte, Saúde, etc.)
5. Se for uma fatura de cartão de crédito analise e agrupe as compras no cartão por tipos e valores de cada tipo de despesa
6. Resumo em 10 palavras

Formato da resposta:
💰 Valor: [valor]
📅 Data: [data]
🏪 Estabelecimento: [nome]
📦 Tipo: [tipo]
💰 Valor Detalhado: [valor por categoria identificada, caso não consiga identificar marque como "outros"]
📝 Resumo: [resumo]`,
        },
        {
          role: 'user',
          content: `Texto para análise: ${text.substring(0, 100000)}`,
        },
      ],
    });

    return (
      completion.choices[0].message.content ||
      'Não consegui analisar o documento'
    );
  } catch (error) {
    console.error('Erro na OpenAI:', error);
    return 'Erro ao processar o documento';
  }
}
app.post('/webhook', async (req, res) => {
  const userPhone = req.body?.From;
  const mediaUrl = req.body?.MediaUrl0;
  const mediaType = req.body?.MediaContentType0;

  // try {
  let responseMessage = '✅ Documento recebido! Analisando...';

  if (mediaUrl) {
    // 1. Download do arquivo
    const fileBuffer = await downloadFile(mediaUrl);

    // 2. Extração de texto
    let extractedText = '';
    if (mediaType === 'application/pdf') {
      extractedText = await extractTextFromPDF(fileBuffer);
    } else {
      const [visionResult] = await visionClient.textDetection(fileBuffer);
      extractedText = visionResult.fullTextAnnotation?.text || '';
    }

    // 3. Processamento com OpenAI
    const analysisResult = await processOCRText(extractedText);

    // 4. Encontrar ou criar usuário
    const user = await prisma.user.upsert({
      where: { phoneNumber: userPhone },
      create: { phoneNumber: userPhone },
      update: {},
    });
    console.log('Usuário:', user);
    console.log('Análise:', analysisResult);
    // 5. Salvar dados no banco
    const savedData = await prisma.$transaction(async (tx) => {
      // Salvar documento
      const document = await tx.document.create({
        data: {
          user: { connect: { id: user.id } },
          originalFilename: mediaUrl.split('/').pop() || 'documento',
          storageUrl: mediaUrl,
          documentType: mediaType === 'application/pdf' ? 'pdf_text' : 'image',
          extractedText: extractedText.substring(0, 10000), // Limite de 10k caracteres
          metadata: analysisResult.document.metadata,
        },
      });

      // Salvar despesa principal
      const expense = await tx.expense.create({
        data: {
          user: { connect: { id: user.id } },
          document: { connect: { id: document.id } },
          amount: analysisResult.expense.amount,
          expenseDate: analysisResult.expense.date,
          category: analysisResult.expense.category
            ? {
                connectOrCreate: {
                  where: { categoryName: analysisResult.expense.category },
                  create: {
                    categoryName: analysisResult.expense.category,
                    description:
                      'Criado automaticamente via análise de documento',
                  },
                },
              }
            : undefined,
          confidenceScore: analysisResult.expense.confidence,
          isItemized: analysisResult.items.length > 0,
        },
      });

      // Salvar itens se existirem
      let savedItems = [];
      if (analysisResult.items.length > 0) {
        savedItems = await Promise.all(
          analysisResult.items.map((item: any) =>
            tx.expenseItem.create({
              data: {
                expense: { connect: { id: expense.id } },
                description: item.description,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                category: item.category
                  ? {
                      connectOrCreate: {
                        where: { categoryName: item.category },
                        create: {
                          categoryName: item.category,
                          description:
                            'Criado automaticamente via item de documento',
                        },
                      },
                    }
                  : undefined,
              },
            }),
          ),
        );
      }

      return { document, expense, items: savedItems };
    });

    // 6. Montar resposta para usuário
    responseMessage = `📊 Análise concluída!\n
Valor total: R$${savedData.expense.amount.toFixed(2)}
Data: ${savedData.expense.expenseDate.toLocaleDateString('pt-BR')}
${
  savedData.items.length > 0
    ? `Itens detectados: ${savedData.items.length}`
    : ''
}`;
  }

  // Enviar resposta via Twilio
  await twilioClient.messages.create({
    body: responseMessage,
    from: process.env.TWILIO_PHONE_NUMBER!,
    to: userPhone,
  });

  res.status(200).send('OK');
  // } catch (error) {
  //   console.error('Erro no processamento:', error);

  //   // Enviar mensagem de erro específica
  //   const errorMessage =
  //     error instanceof OCRProcessingError
  //       ? '❌ Não consegui entender este documento. Poderia enviar em outra qualidade?'
  //       : '⚠️ Ocorreu um erro inesperado. Nossa equipe já foi notificada.';

  //   await twilioClient.messages.create({
  //     body: errorMessage,
  //     from: process.env.TWILIO_PHONE_NUMBER!,
  //     to: userPhone,
  //   });

  //   res.status(500).send('Erro interno');
  // }
});

// Implementação da função processOCRText com tratamento de erros
async function processOCRText(text: string) {
  try {
    const extraction = await openai.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: convertToJsonPrompt.content, // (O prompt completo que mostrei anteriormente)
        },
        {
          role: 'user',
          content: text.substring(0, 6000), // Limite de tokens
        },
      ],
      model: 'gpt-4-turbo',
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const content = extraction.choices[0].message.content;
    if (!content) {
      throw new OCRProcessingError('Documento não reconhecido');
    }
    const data = JSON.parse(content);

    if (data.error) {
      throw new OCRProcessingError('Documento não reconhecido');
    }

    // Validação básica
    if (!data.main_expense?.total_amount || !data.main_expense?.date) {
      throw new OCRProcessingError('Dados essenciais faltando');
    }

    return {
      document: {
        type: data.document_type,
        metadata: data.metadata,
      },
      expense: {
        amount: data.main_expense.total_amount,
        date: new Date(data.main_expense.date),
        category: data.main_expense.primary_category,
        confidence: data.main_expense.confidence_score || 0.8,
      },
      items: data.items?.map((item: any) => ({
        description: item.description,
        quantity: item.quantity || 1,
        unitPrice: item.unit_price,
        category: item.category,
      })),
    };
  } catch (error) {
    console.error('Erro no processamento com OpenAI:', error);
    throw new OCRProcessingError('Falha na análise do documento');
  }
}

class OCRProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OCRProcessingError';
  }
}
app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
