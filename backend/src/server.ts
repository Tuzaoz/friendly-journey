import express from 'express';

import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';
import { openai, twilioClient, visionClient } from './config';
import { downloadFile } from './utils/fileOperations';
import {
  analyzeMessageIntent,
  executeQuery,
} from './utils/generatePrismaQuery';
import {
  extractTextFromPDF,
  OCRProcessingError,
  processOCRText,
} from './utils/textProcessing';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
export const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
});
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const port = process.env.PORT || 3000;

function extractNumber(whatsAppText: string) {
  const plusIndex = whatsAppText.indexOf('+');
  return whatsAppText.substring(plusIndex, whatsAppText.length);
}

async function generateNaturalResponse(
  result: any,
  question: string,
  searchTerm?: string,
) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      {
        role: 'system',
        content: `Você é um assistente financeiro especializado em traduzir dados brutos em respostas naturais e amigáveis. Siga estas regras:

1. **Formatação Humanizada:**
   - Valores monetários: Sempre formate como "R$ X,XX"
   - Datas: Use "dia X de [mês] de YYYY" (ex: 15 de março de 2023)
   - Listas: Destacar 3-5 itens principais quando relevante

2. **Elementos Obrigatórios:**
   - Emojis temáticos no início da resposta
   - Menção ao período analisado quando aplicável
   - Comparação percentual com períodos anteriores (se dados disponíveis)
   - Dica de economia relacionada à pergunta

3. **Proibições Estritas:**
   - ❌ Termos técnicos: "query", "join", "aggregate", "database"
   - ❌ Notação científica/códigos
   - ❌ Referências à estrutura de dados

4. **Tom e Estilo:**
   - Coloquial mas profissional (nível médio de formalidade)
   - Frases curtas (máx. 15 palavras)
   - Uso de metáforas financeiras cotidianas

Exemplo de resposta ruim ❌:
"O aggregate result da query foi 152.30 na sum do amount"

Exemplo de resposta boa ✅:
"🍺 Nas suas últimas compras, você gastou R$ 152,30 com bebidas. Isso equivale a cerca de 12% do seu orçamento mensal para alimentação. Que tal experimentar marcas locais na próxima vez? 😊"

Formato desejado:
[Emoji] [Introdução contextual] [Valor principal] [Detalhe relevante] [Dica ou curiosidade] [Emoji final]`,
      },
      {
        role: 'user',
        content: `Dados brutos: ${JSON.stringify(result)}
Pergunta original: "${question}"
Termo buscado: ${searchTerm || 'N/A'}
---
Gerar resposta usando: 
- Moeda: BRL 
- Período: último mês 
- Categorias relacionadas: alimentação, transporte, lazer`,
      },
    ],
    temperature: 0.3,
    max_tokens: 150,
  });

  return completion.choices[0].message.content;
}

app.post('/webhook', async (req, res) => {
  const userPhone = req.body?.From;
  const mediaUrls = [];
  const mediaTypes = [];

  // Coletar todas as mídias enviadas
  let mediaCount = 0;
  while (req.body[`MediaUrl${mediaCount}`]) {
    mediaUrls.push(req.body[`MediaUrl${mediaCount}`]);
    mediaTypes.push(req.body[`MediaContentType${mediaCount}`]);
    mediaCount++;
  }

  const hasMedia = mediaUrls.length > 0;
  const messageText = req.body?.Body || '';
  let responseMessage;

  try {
    const messageAnalysis = await analyzeMessageIntent(messageText, hasMedia);

    if (messageAnalysis.type === 'query') {
      const user = await prisma.user.findUnique({
        where: { phoneNumber: extractNumber(userPhone) },
      });

      if (!user) {
        throw new Error('Usuário não encontrado');
      }
      const response = await executeQuery(messageAnalysis, user.id);
      responseMessage = await generateNaturalResponse(
        JSON.stringify(response),
        messageText,
        messageAnalysis.sqlQuery,
      );
      await twilioClient.messages.create({
        body: responseMessage || 'Sem resposta',
        from: process.env.TWILIO_PHONE_NUMBER!,
        to: userPhone,
      });

      res.status(200).send('OK');
    } else {
      if (mediaUrls.length > 0) {
        const processedDocuments = [];

        // Processar cada mídia sequencialmente
        for (const [index, mediaUrl] of mediaUrls.entries()) {
          const mediaType = mediaTypes[index];

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
            where: { phoneNumber: extractNumber(userPhone) },
            create: { phoneNumber: extractNumber(userPhone) },
            update: {},
          });

          // 5. Salvar dados no banco
          const savedData = await prisma.$transaction(async (tx) => {
            // Salvar documento
            const document = await tx.document.create({
              data: {
                user: { connect: { id: user.id } },
                originalFilename: mediaUrl.split('/').pop() || 'documento',
                storageUrl: mediaUrl,
                documentType:
                  mediaType === 'application/pdf' ? 'pdf_text' : 'image',
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
                        where: {
                          categoryName: analysisResult.expense.category,
                        },
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
                      totalAmount: item.quantity * item.unitPrice,
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

          processedDocuments.push({
            type: mediaType.includes('pdf') ? 'PDF' : 'Imagem',
            amount: savedData.expense.amount,
            date: savedData.expense.expenseDate,
            itemsCount: savedData.items.length,
          });
        }

        // 6. Montar resposta consolidada
        responseMessage = `📊 Análise de ${processedDocuments.length} documentos concluída!\n\n`;
        responseMessage += processedDocuments
          .map(
            (doc, idx) =>
              `Documento ${idx + 1} (${doc.type}):\n` +
              `• Valor: R$${doc.amount.toFixed(2)}\n` +
              `• Data: ${doc.date.toLocaleDateString('pt-BR')}\n` +
              `• Itens detectados: ${doc.itemsCount}`,
          )
          .join('\n\n');
      } else {
        responseMessage =
          '❌ Nenhum arquivo detectado. Envie imagens ou PDFs para análise';
      }

      // Enviar resposta via Twilio
      await twilioClient.messages.create({
        body: responseMessage,
        from: process.env.TWILIO_PHONE_NUMBER!,
        to: userPhone,
      });

      res.status(200).send('OK');
    }
  } catch (error) {
    console.error('Erro no processamento:', error);

    // Enviar mensagem de erro específica
    const errorMessage =
      error instanceof OCRProcessingError
        ? '❌ Não consegui entender este documento. Poderia enviar em outra qualidade?'
        : '⚠️ Ocorreu um erro inesperado. Nossa equipe já foi notificada.';

    await twilioClient.messages.create({
      body: errorMessage,
      from: process.env.TWILIO_PHONE_NUMBER!,
      to: userPhone,
    });

    res.status(500).send('Erro interno');
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
