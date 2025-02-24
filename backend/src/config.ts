import { ImageAnnotatorClient } from '@google-cloud/vision';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import path from 'path';
import { Twilio } from 'twilio';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

export const visionClient = new ImageAnnotatorClient({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
});

export const twilioClient = new Twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
