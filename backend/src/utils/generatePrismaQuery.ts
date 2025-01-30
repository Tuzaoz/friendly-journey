import { openai, prisma } from '../server';

// Tipos para as consultas
interface QueryResult {
  type: 'query';
  prismaQuery: string;
  naturalResponse: string;
}

interface DocumentResult {
  type: 'document';
}

type MessageAnalysis = QueryResult | DocumentResult;

// Função para analisar o tipo de mensagem
export async function analyzeMessageIntent(
  message: string,
  hasMedia: boolean,
): Promise<MessageAnalysis> {
  if (hasMedia) {
    return { type: 'document' };
  }

  const analysis = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      {
        role: 'system',
        content: `Você é um analisador de intenção de mensagens financeiras.
        Determine se a mensagem é uma consulta sobre gastos/finanças.
        
        Exemplos de consultas:
        - Perguntas sobre valores: "Quanto gastei..."
        - Análises temporais: "No mês passado..."
        - Consultas por categoria: "Gastos com alimentação..."
        - Status de despesas: "Despesas pendentes..."
        - Análises de documentos: "Faturas processadas..."
        
        Retorne um JSON:
        {
          "isQuery": boolean,
          "confidence": number,
          "queryType": "amount|temporal|category|status|document|unknown"
        }`,
      },
      {
        role: 'user',
        content: message,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  const intent = JSON.parse(analysis.choices[0].message.content || '{}');
  const categories = await prisma.expenseCategory.findMany();

  const categoryNames = categories
    .map((category) => category.categoryName)
    .join(', ');
  if (intent.isQuery && intent.confidence > 0.7) {
    const queryResult = await generatePrismaQuery(
      message,
      categoryNames,
      intent.queryType,
    );
    return queryResult;
  }

  return { type: 'document' };
}

// Função para gerar consulta Prisma
async function generatePrismaQuery(
  question: string,
  categories: string,
  queryType: string,
): Promise<QueryResult> {
  const completion = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      {
        role: 'system',
        content: `Você é um especialista em converter perguntas em consultas Prisma.
        
        Schema resumido:
        - User: id, phoneNumber
        - Document: id, userId, documentType, documentSubtype, processed
        - ExpenseCategory: id, categoryName
        - Expense: id, userId, documentId, amount, expenseDate, categoryId, status(pending/verified/rejected), isItemized
        - ExpenseItem: id, expenseId, description, quantity, unitPrice, categoryId

        Regras importantes:
        1. Sempre inclua userId no where para filtrar por usuário
        2. Use aggregations (_sum, _avg, _count) quando apropriado
        3. Para datas, use intervalos (gte/lte)
        4. Para categorias, use contains/startsWith para busca flexível de nomes sem case sensitive
        5. Utilize includes quando precisar de dados relacionados
        6. Limite resultados com take quando retornar listas
        7. considere as categoryName disponíveis: ${categories}
        Retorne um JSON:
        {
          "prismaQuery": string (código da consulta),
          "naturalResponse": string (template resposta),
          "includeChart": boolean (se deve gerar gráfico)
        }

        Exemplos de queries:
        1. "Quanto gastei este mês?"
        {
          "prismaQuery": "prisma.expense.aggregate({ 
            where: { 
              userId,
              expenseDate: { 
                gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
                lt: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
              },
              status: 'verified'
            },
            _sum: { amount: true }
          })",
          "naturalResponse": "📊 Seus gastos este mês somam R$ {amount}",
          "includeChart": false
        }

        2. "Gastos por categoria no último trimestre"
        {
          "prismaQuery": "prisma.expense.groupBy({
            by: ['categoryId'],
            where: {
              userId,
              status: 'verified',
              expenseDate: {
                gte: new Date(new Date().setMonth(new Date().getMonth() - 3))
              }
            },
            _sum: { amount: true },
            orderBy: { _sum: { amount: 'desc' } },
            include: { category: true }
          })",
          "naturalResponse": "📈 Gastos por categoria (último trimestre):\\n{categories}",
          "includeChart": true
        }`,
      },
      {
        role: 'user',
        content: question,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  return {
    type: 'query',
    ...JSON.parse(completion.choices[0].message.content || '{}'),
  };
}

// Função para executar a consulta e formatar resposta
export async function executeQuery(queryResult: QueryResult, userId: number) {
  try {
    const queryFunction = new Function(
      'prisma',
      'userId',
      'Date',
      `return ${queryResult.prismaQuery}`,
    );

    const results = await queryFunction(prisma, userId, Date);

    // Formatar resposta baseado nos resultados
    console.log('Resultados:', results._sum.amount);
    return results;
  } catch (error) {
    console.error('Erro ao executar query:', error);
    return '❌ Desculpe, não consegui processar sua consulta. Tente reformular a pergunta.';
  }
}
