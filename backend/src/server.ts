import express from "express";
import { Twilio } from "twilio";

import path from "path";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import axios from "axios";
import OpenAI from "openai";
import pdf from "pdf-parse";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const port = process.env.PORT || 3000;

// Configuração dos clientes
const visionClient = new ImageAnnotatorClient({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  },
});

const twilioClient = new Twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Renomeie a função para propósito genérico
async function downloadFile(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID!,
      password: process.env.TWILIO_AUTH_TOKEN!,
    },
  });
  return Buffer.from(response.data, "binary");
}

// Função para extrair texto de PDFs textuais
async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  try {
    const data = await pdf(buffer);
    return data.text;
  } catch (error) {
    throw new Error("Falha ao extrair texto do PDF");
  }
}
async function processTextWithAI(text: string): Promise<string> {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
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
          role: "user",
          content: `Texto para análise: ${text.substring(0, 100000)}`,
        },
      ],
    });

    return (
      completion.choices[0].message.content ||
      "Não consegui analisar o documento"
    );
  } catch (error) {
    console.error("Erro na OpenAI:", error);
    return "Erro ao processar o documento";
  }
}
// Modifique a rota do webhook
app.post("/webhook", async (req, res) => {
  const userMessage = req.body?.Body;
  const userPhone = req.body?.From;
  const mediaUrl = req.body?.MediaUrl0;
  const mediaType = req.body?.MediaContentType0;

  try {
    let responseMessage = "✅ Mensagem recebida!";

    if (mediaUrl) {
      const fileBuffer = await downloadFile(mediaUrl);
      let extractedText = "";

      // Processamento diferente para PDFs
      if (mediaType === "application/pdf") {
        try {
          // Tentativa de extração de PDF textual
          extractedText = await extractTextFromPDF(fileBuffer);
          console.log(extractedText);
          // Verifica se o texto é válido
          if (extractedText.length < 50) {
            throw new Error("PDF possivelmente escaneado");
          }
        } catch (error) {
          // Fallback para Google Vision se for PDF escaneado
          const [result] = await visionClient.textDetection(fileBuffer);
          extractedText = result.fullTextAnnotation?.text || "";

          if (!extractedText) {
            throw new Error("Não foi possível ler o PDF");
          }
        }
      } else {
        // Processamento normal para imagens
        const [result] = await visionClient.textDetection(fileBuffer);
        extractedText = result.fullTextAnnotation?.text || "";
      }

      // Processamento com OpenAI
      const aiResponse = await processTextWithAI(extractedText);
      responseMessage = `📄 Documento analisado:\n\n${aiResponse}`;
    }

    await twilioClient.messages.create({
      body: responseMessage,
      from: process.env.TWILIO_PHONE_NUMBER!,
      to: userPhone,
    });

    res.status(200).send("OK");
  } catch (error) {
    console.error("Erro:", error);

    // Mensagem de erro específica para PDFs
    const errorMessage =
      mediaType === "application/pdf"
        ? "⚠️ PDF escaneado detectado! Envie cada página como imagem separada para análise completa."
        : "Erro ao processar o arquivo";

    await twilioClient.messages.create({
      body: errorMessage,
      from: process.env.TWILIO_PHONE_NUMBER!,
      to: userPhone,
    });

    res.status(500).send("Erro interno");
  }
});
app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
