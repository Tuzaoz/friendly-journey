import { openai } from '../config';
import {  prisma } from '../server';

// Tipos para as consultas
interface QueryResult {
  type: 'query';
  sqlQuery: string;
  naturalResponse: string;
  includeChart: boolean;
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

// Função para gerar consulta SQL
async function generatePrismaQuery(
  question: string,
  categories: string,
  queryType: string,
): Promise<QueryResult> {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-2024-08-06',
    messages: [
      {
        role: 'system',
        content: `Você é um especialista em converter perguntas em linguagem natural em consultas SQL para PostgreSQL em um sistema de análise financeira. 

Contexto completo do sistema:
1. Modelagem de Dados:
   - Documents: Registra recibos/faturas digitalizados (imagens/PDFs)
   - Expenses: Despesas principais vinculadas a documentos
   - ExpenseItems: Itens individuais dentro de uma despesa (ex: produtos de supermercado)
   - ExpenseCategories: Categorias principais (Alimentação, Saúde, etc)
   - ExpenseSubcategories: Subdivisões especializadas (ex: Bebidas Alcoólicas, Academia)

2. Padrões de Busca Comuns:
   - Agregações temporais (dia/mês/ano)
   - Comparação entre períodos
   - Busca por produtos específicos em ExpenseItems
   - Análise por categoria/subcategoria
   - Detecção de padrões de gastos

3. Regras Essenciais:
   *SEMPRE* incluir:
   - WHERE user_id = :userId 
   - JOINs corretos entre expenses/items/documents
   - Tratamento de datas (expense_date)
   - Conversão monetária (total_amount em BRL)
   
4. Estratégias de Busca:
   (1) Para produtos específicos (ex: "ovos"):
   - Usar ILIKE em expense_items.description
   - Considerar sinônimos (ex: "cerveja" inclui "IPA", "lager")
   
   (2) Para subcategorias:
   - JOIN com expense_subcategories
   - Busca semântica (ex: "academia" → "Atividades Esportivas")

   (3) Para documentos:
   - Relacionar com document_type/subtype
   - Considerar payment_method no metadata

   Regras temporais obrigatórias:
1. Para meses sem ano especificado (ex: "janeiro"):
   - Usar EXTRACT(MONTH FROM e.expense_date) = 1 (janeiro)
   - E EXTRACT(YEAR FROM e.expense_date) = EXTRACT(YEAR FROM CURRENT_DATE)
   
2. Sempre usar CURRENT_DATE como referência temporal
3. Nunca usar datas fixas (ex: '2023-01-01')
Exemplos Avançados:

1. "Valor gasto com cerveja último mês":
SELECT SUM(total_amount) as total, COUNT(*)
FROM expense_items ei
JOIN expenses e ON e.id = ei.expense_id
LEFT JOIN expense_subcategories es ON es.id = ei.subcategory_id
WHERE e.user_id = :userId
  AND e.expense_date >= NOW() - INTERVAL '1 month'
  AND (ei.description ILIKE '%cerveja%' 
       OR es.name ILIKE '%bebidas alcoólicas%')

2. "Histórico de preços de ovos":
SELECT ei.description, ei.unit_price, e.expense_date
FROM expense_items ei
JOIN expenses e ON e.id = ei.expense_id
WHERE e.user_id = :userId
  AND ei.description ILIKE '%ovos%'
ORDER BY e.expense_date DESC

3. "Comparativo mensal de alimentação":
SELECT 
  DATE_TRUNC('month', e.expense_date) as mes,
  SUM(ei.total_amount) as total
FROM expense_items ei
JOIN expenses e ON e.id = ei.expense_id
JOIN expense_categories ec ON ec.id = ei.category_id
WHERE e.user_id = :userId
  AND ec.category_name = 'Alimentação'
GROUP BY mes
ORDER BY mes DESC
LIMIT 6

4. "Detalhamento de última compra no mercado":
SELECT ei.description, ei.quantity, ei.unit_price, ei.total_amount
FROM expense_items ei
JOIN expenses e ON e.id = ei.expense_id
JOIN documents d ON d.id = e.document_id
WHERE e.user_id = :userId
  AND d.document_subtype = 'market_receipt'
ORDER BY e.expense_date DESC
LIMIT 10

Gere SQL que:
- Priorize performance (use índices existentes)
- Trate dados faltantes (COALESCE)
- Previna SQL injection (não interpolar valores)
- Use alias claros (ex: total_mensal)
- Limite resultados quando aplicável
- Retorne um JSON com o seguinte formato: {
  "sqlQuery": "SELECT ... FROM ... WHERE ...",
  "naturalResponse": "Resposta natural para a pergunta",
  "includeChart": true
      }`

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

// Nova função de execução com SQL
export async function executeQuery(queryResult: QueryResult, userId: number) {
  try {
    console.log('Executando query:', queryResult.sqlQuery);
    
    const results = await prisma.$queryRawUnsafe(
      queryResult.sqlQuery.replace(/:userId/g, userId.toString())
    );

    console.log('Resultados:', results);
    return results;
  } catch (error) {
    console.error('Erro na execução SQL:', error);
    return '❌ Erro ao processar sua solicitação. Tente reformular a pergunta.';
  }
}
