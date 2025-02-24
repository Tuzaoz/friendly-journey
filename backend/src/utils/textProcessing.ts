import pdf from 'pdf-parse';
import { openai } from '../config';

export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  try {
    const data = await pdf(buffer);
    return data.text;
  } catch (error) {
    throw new Error('Falha ao extrair texto do PDF');
  }
}

export async function processTextWithAI(text: string): Promise<string> {
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

export async function processOCRText(text: string) {
  try {
    const extraction = await openai.chat.completions.create({
      messages: [
        { role: 'system', content: '' },
        {
          role: 'system',
          content: convertToJsonPrompt.content, // (O prompt completo que mostrei anteriormente)
        },
        {
          role: 'user',
          content: text.substring(0, 6000), // Limite de tokens
        },
      ],
      model: 'gpt-3.5-turbo',
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

export class OCRProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OCRProcessingError';
  }
} 