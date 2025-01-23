import express from "express";
import { Twilio } from "twilio";
import dotenv from "dotenv";
import path from "path";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import axios from "axios";
import OpenAI from "openai";

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

// Função para baixar arquivos
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

async function processTextWithAI(text: string): Promise<string> {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // ou "gpt-3.5-turbo" para versão mais econômica
      messages: [
        {
          role: "system",
          content:
            "Você é um assistente financeiro especialista em analisar extratos bancários, faturas e recibos. Formate a resposta com emojis e itens.",
        },
        {
          role: "user",
          content: `Analise este texto extraído de um documento financeiro e me diga:
1. Valor total
2. Data da transação
3. Estabelecimento/comerciante
4. Tipo de gasto (alimentação, transporte, etc.)
          
Texto: ${text.substring(0, 3000)}`, // Limitando para controlar custos
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
// Rota do Webhook
app.post("/webhook", async (req, res) => {
  const userMessage = req.body?.Body;
  const userPhone = req.body?.From;
  const mediaUrl = req.body?.MediaUrl0;

  try {
    let responseMessage = "✅ Mensagem recebida!";

    if (mediaUrl) {
      const imageBuffer = await downloadFile(mediaUrl);
      const [result] = await visionClient.textDetection(imageBuffer);
      const extractedText =
        result.fullTextAnnotation?.text || "Texto não encontrado.";

      // Chamada nova para a OpenAI
      const aiResponse = await processTextWithAI(extractedText);

      responseMessage = `📊 Análise do documento:\n\n${aiResponse}`;
    }

    await twilioClient.messages.create({
      body: responseMessage,
      from: process.env.TWILIO_PHONE_NUMBER!,
      to: userPhone,
    });

    res.status(200).send("OK");
  } catch (error) {
    console.error("Erro:", error);
    res.status(500).send("Erro interno");
  }
});
app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
