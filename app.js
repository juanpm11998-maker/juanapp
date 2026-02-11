
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { GoogleGenAI, Type, Modality } from "@google/genai";
import jwt from 'jsonwebtoken';

const app = express();
// Fix: Removed unnecessary and potentially problematic cast on express.json()
app.use(express.json());

// La API Key está protegida en el servidor mediante variables de entorno
// Correct: Using new GoogleGenAI({ apiKey: process.env.API_KEY })
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const JWT_SECRET = process.env.JWT_SECRET || 'syncfit_super_secret_key_2025';

// Almacén en memoria para límites de uso (En producción usar Redis)
const usageLimits = new Map<string, { count: number, lastReset: number }>();
const MAX_REQUESTS_PER_DAY = 10;

// Middleware de Autenticación JWT
// Fix: Use RequestHandler to properly type req, res, and next, resolving missing property errors
const authenticateToken: RequestHandler = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({ error: 'Token requerido' });
    return;
  }

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) {
      res.status(403).json({ error: 'Token inválido o expirado' });
      return;
    }
    (req as any).user = user;
    next();
  });
};

// Middleware de Rate Limiting por usuario
// Fix: Use RequestHandler for consistent typing across middleware
const checkRateLimit: RequestHandler = (req, res, next) => {
  const user = (req as any).user;
  if (!user) return res.status(401).json({ error: 'Usuario no autenticado' });
  
  const userId = user.id;
  const now = Date.now();
  const dayInMs = 24 * 60 * 60 * 1000;
  
  let userData = usageLimits.get(userId);

  if (!userData || (now - userData.lastReset) > dayInMs) {
    userData = { count: 0, lastReset: now };
  }

  if (userData.count >= MAX_REQUESTS_PER_DAY) {
    return res.status(429).json({ 
      error: 'Límite diario alcanzado', 
      message: 'Has usado tus 10 créditos diarios. Mejora a PRO para uso ilimitado.' 
    });
  }

  userData.count++;
  usageLimits.set(userId, userData);
  console.log(`[LOG] Usuario ${user.email} - Uso: ${userData.count}/${MAX_REQUESTS_PER_DAY}`);
  next();
};

// AUTH: Login/Registro simplificado
// Fix: Explicitly use express types to avoid conflicts with global types
app.post('/auth/login', (req: express.Request, res: express.Response) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Email inválido' });
  }

  // En un producto real, aquí validaríamos contraseña y buscaríamos en DB
  const user = { id: 'u_' + Math.random().toString(36).substr(2, 9), email };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });

  res.json({ user, token });
});

// API: Generar Workout (Protegido)
// Fix: Use express types for req and res and access Gemini response correctly
app.post('/api/generate-workout', authenticateToken, checkRateLimit, async (req: express.Request, res: express.Response) => {
  const { type, goal, rounds } = req.body;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: `Generate a structured ${type} workout focused on ${goal} for ${rounds} rounds.`,
      config: {
        systemInstruction: "You are an elite fitness coach. Return ONLY a JSON object with an 'exercises' array. Each exercise must have 'name' and 'description'. Be concise to save tokens.",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            exercises: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  description: { type: Type.STRING }
                },
                required: ["name", "description"]
              }
            }
          },
          required: ["exercises"]
        }
      }
    });

    // Correct: Use .text property to get the generated text
    const data = JSON.parse(response.text || '{"exercises":[]}');
    res.json(data);
  } catch (error) {
    console.error("Gemini Error:", error);
    res.status(500).json({ error: 'Error al generar la rutina' });
  }
});

// API: Generar TTS (Protegido)
// Fix: Handle audio modalities and response candidates according to guidelines
app.post('/api/generate-tts', authenticateToken, async (req: express.Request, res: express.Response) => {
  const { text } = req.body;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: `Encouraging coach voice: ${text}` }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    });

    // Correct: Extracting inlineData from candidate parts
    const audioBase64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioBase64) throw new Error("No audio data received");

    res.json({ audioBase64 });
  } catch (error) {
    console.error("TTS Error:", error);
    res.status(500).json({ error: 'Error en el servicio de voz' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend SyncFit corriendo en puerto ${PORT}`));
