require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdf = require('pdf-parse');

// ثوابت سلامة من حزمة Gemini
const { HarmBlockThreshold, HarmCategory } = require('@google/generative-ai');
const { getGeminiAIInstance, updateApiKeyStatus } = require('./apiKeysManager');

const app = express();

// Railway يحدد المنفذ عبر ENV
const port = process.env.PORT || 3000;

/* ------------------------------------------------------------------
   ✅ CORS configuration (يدعم Vercel + Railway + localhost)
------------------------------------------------------------------- */

// ضع هنا كل الأصول (frontends) المعروفة صراحةً
const allowedOrigins = [
  'http://localhost:5173', // Vite
  'http://localhost:3000', // لو عندك واجهة محلية
  'https://quiz-time-294ri44we-dr-ahmed-alenanys-projects.vercel.app', // مشروع Vercel الحالي
  'https://quiz-puplic-production.up.railway.app', // (لو حصل طلبات cross بين نفس الدومين)
];

// دوال مساعدة للتحقق من الدومين بشكل ديناميكي
const isAllowedDynamic = (origin) => {
  if (!origin) return true; // للسماح بأدوات مثل curl و Postman
  try {
    const url = new URL(origin);
    const host = url.hostname;

    // السماح لأي deploy من Vercel
    if (host.endsWith('.vercel.app')) return true;

    // السماح بأي subdomain من Railway
    if (host.endsWith('.up.railway.app')) return true;

    // السماح بالقائمة البيضاء الصريحة
    if (allowedOrigins.includes(origin)) return true;

    return false;
  } catch {
    return false;
  }
};

app.use((req, res, next) => {
  // CORS الديناميكي
  const origin = req.headers.origin;
  if (isAllowedDynamic(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  );
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With'
  );
  // لو بتحتاج Cookies مع CORS (حالياً مش لازم):
  // res.header('Access-Control-Allow-Credentials', 'true');

  // التعامل مع الـ preflight بسرعة
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// لو حابب كمان تستخدم cors() كطبقة إضافية (مش ضروري بعد الهاندلر اللي فوق)
// بس هنخليه نسخه آمنة تقبل نفس المنطق
app.use(
  cors({
    origin: (origin, cb) => {
      if (isAllowedDynamic(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    // credentials: true, // فعلها لو هتستخدم كوكيز عبر الدومينات
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);

// احتياطي: تفعيل رد الـ OPTIONS لكل المسارات
app.options('*', cors());

/* ------------------------------------------------------------------
   Parsers & Uploads
------------------------------------------------------------------- */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// تخزين الملفات في الذاكرة (مؤقت)
const upload = multer({ storage: multer.memoryStorage() });

/* ------------------------------------------------------------------
   ثابت لأنواع الأسئلة
------------------------------------------------------------------- */
const allQuestionTypes = [
  'MCQ',
  'TrueFalse',
  'ShortAnswer',
  'Ordering',
  'Matching',
];

/* ------------------------------------------------------------------
   Utils لمعالجة الملفات
------------------------------------------------------------------- */
const fileToGenerativePart = async (fileBuffer, mimeType) => {
  return {
    inlineData: {
      mimeType: mimeType,
      data: fileBuffer.toString('base64'),
    },
  };
};

const getDocumentText = async (fileBuffer, mimeType) => {
  if (mimeType === 'application/pdf') {
    try {
      const data = await pdf(fileBuffer);
      return data.text;
    } catch (error) {
      console.error('Error parsing PDF in backend:', error);
      throw new Error(
        'Could not extract text from PDF. The file might be corrupted or image-based.'
      );
    }
  } else if (mimeType && mimeType.startsWith('text/')) {
    return fileBuffer.toString('utf8');
  }
  // افتراضيًا: محاولة تحويل أي شيء لنص
  return fileBuffer.toString('utf8');
};

/* ------------------------------------------------------------------
   Schema لردّ Gemini
------------------------------------------------------------------- */
const geminiResponseSchema = {
  type: 'OBJECT',
  properties: {
    quizTitle: {
      type: 'STRING',
      description: `A creative and relevant title for the quiz.`,
    },
    quizData: {
      type: 'ARRAY',
      description: `An array of all generated quiz question objects.`,
      items: {
        type: 'OBJECT',
        properties: {
          questionType: {
            type: 'STRING',
            description:
              'Type of question. Must be one of the requested types.',
            enum: ['MCQ', 'TrueFalse', 'ShortAnswer', 'Ordering', 'Matching'],
          },
          question: { type: 'STRING', description: `The question text.` },
          options: {
            type: 'ARRAY',
            description:
              'Array of options. For MCQ/TrueFalse, it holds the choices. For Ordering, it holds the items to be ordered. For Matching, it holds the prompts. For ShortAnswer, it is [].',
            items: { type: 'STRING' },
          },
          matchOptions: {
            type: 'ARRAY',
            description: `Optional: Array of answer items for Matching questions.`,
            items: { type: 'STRING' },
          },
          correctAnswer: {
            type: 'STRING',
            description:
              "The correct answer. For MCQ, TrueFalse, and ShortAnswer, this is a string. For Ordering and Matching questions, this MUST be a JSON.stringified array.",
          },
          explanation: {
            type: 'STRING',
            description: `Detailed, multi-part explanation.`,
          },
          caseDescription: {
            type: 'STRING',
            description: `Optional: A case study, scenario, or context for the question.`,
          },
          refersToUploadedImageIndex: {
            type: 'INTEGER',
            description:
              'Optional: The 0-based index of the uploaded image this question refers to.',
          },
          isFlawed: {
            type: 'BOOLEAN',
            description: 'Set to true if the question is flawed.',
          },
        },
        required: [
          'questionType',
          'question',
          'options',
          'correctAnswer',
          'explanation',
        ],
      },
    },
  },
  required: ['quizTitle', 'quizData'],
};

/* ------------------------------------------------------------------
   Prompt Generator
------------------------------------------------------------------- */
const getGenerationPrompt = (
  prompt,
  subject,
  parsedSettings,
  fileContent,
  imagesCount,
  imageUsage
) => {
  const mainContentPrompt = prompt
    ? `\n\nUser's specific text content: "${prompt}"`
    : fileContent
    ? `\n\nGenerate the quiz from this document:\n---BEGIN DOCUMENT---\n${fileContent}\n---END DOCUMENT---`
    : imagesCount > 0
    ? '\n\nGenerate the quiz *exclusively* from the provided image(s).'
    : '';

  let imageInstruction = '';
  if (imagesCount > 0) {
    const numImgQ = parseInt(parsedSettings.numImageQuestions, 10);
    if (!isNaN(numImgQ) && numImgQ > 0) {
      let instructionText = '';
      switch (imageUsage) {
        case 'link':
          instructionText = `You MUST generate exactly ${numImgQ} question(s) that require the user to analyze the provided images in conjunction with the provided text content.`;
          break;
        case 'about':
          instructionText = `You MUST generate exactly ${numImgQ} question(s) that are directly about the visual content of the provided images.`;
          break;
        case 'auto':
        default:
          instructionText = `Generate ${numImgQ} question(s) based on the provided images. Use your expert judgment to decide the best pedagogical approach: either by asking questions that require synthesizing information from both the text and images, or by asking questions that focus solely on interpreting the images' content.`;
          break;
      }
      imageInstruction = `
# Image-Based Question Instructions
- You have been provided with ${imagesCount} image(s). They are 0-indexed.
- ${instructionText}
- For these questions, the 'question' text must clearly refer to the image (e.g., "Based on the first X-ray...", "In the image of the cell (image 1)...").
- You MUST set 'refersToUploadedImageIndex' to the 0-based index of the image being used for all questions that use an image.`;
    }
  }

  const requestedQuestionTypesFormatted = JSON.stringify(
    parsedSettings.questionTypes.length > 0
      ? parsedSettings.questionTypes
      : allQuestionTypes
  );

  return `
// AI Execution Protocol: Version 3.2 (Adaptive Quiz Generation with Multi-Type Questions & Deterministic Answer Distribution)

# Primary Directive
Your primary function is to act as an expert examinations author. You will generate high-quality questions based *exclusively* on the provided content. The questions will be of the types explicitly requested by the user. All information must be derived from the provided content. The final output must be a single JSON object adhering to the schema.

# Input
- Content: Scientific text and/or Images. This is the sole source of information.
- Configuration: Detailed instructions on the number and type of questions, and and how to use images.

# Protocol 0: Content Domain Analysis & Role Adaptation
## Objective
Analyze the provided 'User Content' to infer its primary domain (e.g., Medical, Engineering, General Science, Humanities, etc.). Adapt your role and question generation style to match the rigor, terminology, and typical question patterns of that specific domain.

## Rules
1.  **Domain Inference:** Before generating any questions, perform a rapid internal analysis of the 'User Content'.
2.  **Role Adaptation:** Use domain-specific tone and terminology.
3.  **Quality:** Use clear, precise domain-specific language. Avoid ambiguity.

# Protocol 1: Content Generation (Multi-Type Questions & Case Scenarios)
- Follow the exact structures for MCQ, TrueFalse, ShortAnswer, Ordering, Matching as previously described.
- All parts must be derived from the provided content.

# Protocol 2: Answer Distribution Correction (Deterministic & Balanced)
- Internally rebalance answer positions to avoid bias.

# Final Generation Task
- Output a single JSON object adhering to the provided schema.

## User Configuration
- Subject: '${subject || 'the provided content'}'
- Quiz Language: ${parsedSettings.quizLanguage}
- Explanation Language: ${parsedSettings.explanationLanguage}
- Difficulty: '${parsedSettings.difficulty}'
- **Requested Question Types**: ${requestedQuestionTypesFormatted}
- **Standalone MCQs to Generate**: ${parsedSettings.numMCQs}
- **Case Scenarios to Generate**: ${parsedSettings.numCases}
- **MCQs per Case Scenario**: ${parsedSettings.questionsPerCase}
${parsedSettings.additionalInstructions ? `- Additional Instructions: "${parsedSettings.additionalInstructions}"` : ''}

## User Content & Image Instructions
${mainContentPrompt}
${imageInstruction}`;
};

/* ------------------------------------------------------------------
   Health check
------------------------------------------------------------------- */
app.get('/', (req, res) => {
  res.send('Quiz Time Backend API is running!');
});

/* ------------------------------------------------------------------
   /generate-quiz
------------------------------------------------------------------- */
app.post(
  '/generate-quiz',
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'images', maxCount: 5 },
  ]),
  async (req, res) => {
    const { prompt, settings } = req.body;
    const file =
      req.files && req.files['file'] ? req.files['file'][0] : null;
    const images = req.files && req.files['images'] ? req.files['images'] : [];

    let parsedSettings;
    try {
      parsedSettings = JSON.parse(settings);
    } catch (e) {
      return res
        .status(400)
        .json({ error: 'Invalid settings format. Settings must be valid JSON.' });
    }

    const MAX_TEXT_LENGTH = 40000;
    const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;
    const MAX_PDF_CHARS = 50000;
    const MAX_IMAGES = 5;
    const MAX_TOTAL_QUESTIONS = 50;

    if (prompt && prompt.length > MAX_TEXT_LENGTH) {
      return res
        .status(400)
        .json({ error: `Prompt text exceeds ${MAX_TEXT_LENGTH} characters.` });
    }

    let fileContent = null;
    if (file) {
      if (file.size > MAX_PDF_SIZE_BYTES) {
        return res.status(400).json({ error: `PDF file exceeds limit.` });
      }
      try {
        fileContent = await getDocumentText(file.buffer, file.mimetype);
        if (fileContent.length > MAX_PDF_CHARS) {
          return res.status(400).json({
            error: `Extracted PDF text exceeds ${MAX_PDF_CHARS} characters.`,
          });
        }
      } catch (e) {
        return res
          .status(500)
          .json({ error: `Error processing PDF: ${e.message}` });
      }
    }

    if (images.length > MAX_IMAGES) {
      return res
        .status(400)
        .json({ error: `Maximum ${MAX_IMAGES} images allowed.` });
    }

    const totalMCQs = parseInt(parsedSettings.numMCQs, 10) || 0;
    const totalCases = parseInt(parsedSettings.numCases, 10) || 0;
    const qPerCase = parseInt(parsedSettings.questionsPerCase, 10) || 0;
    const totalImageQuestions = parseInt(parsedSettings.numImageQuestions, 10) || 0;
    const calculatedTotalQuestions =
      totalMCQs + totalCases * qPerCase + totalImageQuestions;

    if (calculatedTotalQuestions === 0) {
      return res.status(400).json({ error: 'No questions requested.' });
    }
    if (calculatedTotalQuestions > MAX_TOTAL_QUESTIONS) {
      return res
        .status(400)
        .json({ error: `Total questions exceed ${MAX_TOTAL_QUESTIONS}.` });
    }

    let aiInstance = null;
    let usedKey = null;

    try {
      const { ai, key } = getGeminiAIInstance();
      aiInstance = ai;
      usedKey = key;

      const generationPrompt = getGenerationPrompt(
        prompt,
        null,
        parsedSettings,
        fileContent,
        images.length,
        parsedSettings.imageUsage
      );

      const promptParts = [{ text: generationPrompt }];
      for (const img of images) {
        promptParts.push(await fileToGenerativePart(img.buffer, img.mimetype));
      }

      const model = aiInstance.getGenerativeModel({
        model: 'gemini-2.5-flash',
      });

      const response = await model.generateContent({
        contents: { parts: promptParts },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: geminiResponseSchema,
          temperature: parsedSettings.temperature,
          topP: parsedSettings.topP,
          topK: parsedSettings.topK,
        },
        safetySettings: [
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
        ],
      });

      const jsonText = response.response.text().trim();
      let parsedQuiz;
      try {
        parsedQuiz = JSON.parse(jsonText);
      } catch (e) {
        console.error('Failed to parse JSON from model:', jsonText);
        throw new Error('The AI model returned an invalid response.');
      }

      const processedQuizData = parsedQuiz.quizData.map((q) => {
        let processedQuestion = { ...q };

        if (q.questionType === 'Ordering' || q.questionType === 'Matching') {
          try {
            if (typeof q.correctAnswer === 'string') {
              processedQuestion.correctAnswer = JSON.parse(q.correctAnswer);
            } else {
              processedQuestion.isFlawed = true;
            }
          } catch {
            processedQuestion.isFlawed = true;
          }
        }

        if (processedQuestion.questionType === 'MCQ') {
          const correctIndex = processedQuestion.options.findIndex(
            (opt) =>
              typeof processedQuestion.correctAnswer === 'string' &&
              opt.toLowerCase().trim() ===
                processedQuestion.correctAnswer.toLowerCase().trim()
          );
          processedQuestion.correctAnswerIndex =
            correctIndex > -1 ? correctIndex : 0;
        } else if (processedQuestion.questionType === 'TrueFalse') {
          if (typeof processedQuestion.correctAnswer === 'string') {
            const ans = processedQuestion.correctAnswer.toLowerCase().trim();
            processedQuestion.correctAnswerIndex =
              ans === 'true' ? 0 : ans === 'false' ? 1 : -1;
          } else {
            processedQuestion.correctAnswerIndex = -1;
            processedQuestion.isFlawed = true;
          }
        } else {
          processedQuestion.correctAnswerIndex = -1;
        }

        return processedQuestion;
      });

      updateApiKeyStatus(usedKey, true);
      return res
        .status(200)
        .json({ ...parsedQuiz, quizData: processedQuizData });
    } catch (error) {
      console.error('Gemini API call failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (usedKey) updateApiKeyStatus(usedKey, false, errorMessage);

      if (errorMessage.includes('API key') || errorMessage.includes('403')) {
        return res
          .status(401)
          .json({ error: 'Invalid or unauthorized API Key.' });
      }
      if (errorMessage.includes('400') || errorMessage.includes('responseSchema')) {
        return res
          .status(400)
          .json({ error: 'Bad request. Try reducing content or questions.' });
      }
      if (errorMessage.includes('503')) {
        return res
          .status(503)
          .json({ error: 'AI service unavailable. Try later.' });
      }
      if (errorMessage.includes('No Gemini API key')) {
        return res
          .status(500)
          .json({ error: errorMessage + ' All keys unavailable.' });
      }
      return res
        .status(500)
        .json({ error: `Failed to generate quiz. Error: ${errorMessage}` });
    }
  }
);

/* ------------------------------------------------------------------
   Start server
------------------------------------------------------------------- */
app.listen(port, () => {
  console.log(`Quiz Time Backend Server running on port ${port}`);
});
