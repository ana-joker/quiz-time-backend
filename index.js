// index.js
require('dotenv').config(); // تحميل متغيرات البيئة من ملف .env

const express = require('express');
const cors = require('cors'); // مكتبة CORS
const multer = require('multer');
const pdf = require('pdf-parse'); // مكتبة لمعالجة PDF
const helmet = require('helmet'); // 🔒 إضافة Helmet للأمان
const Joi = require('joi'); // 🛡️ إضافة Joi للتحقق من صحة المدخلات

// ثوابت سلامة من حزمة Gemini (الحزمة الجديدة قد لا تحتاجها هنا مباشرة)
// سنستخدمها في الـ model.generateContent مباشرة
const { HarmBlockThreshold, HarmCategory, GoogleGenerativeAI } = require('@google/genai'); // 🚀 تحديث: استيراد من الحزمة الجديدة
// استيراد مدير مفاتيح API الذي أنشأناه
const { getGeminiAIInstance, updateApiKeyStatus } = require('./apiKeysManager');

const app = express();

// Railway يحدد المنفذ عبر ENV، أو نستخدم 3000 كافتراضي محلي
const port = process.env.PORT || 3000;

/* ------------------------------------------------------------------
   🔒 إضافة Helmet (طبقة أمان أساسية)
------------------------------------------------------------------- */
app.use(helmet());

/* ------------------------------------------------------------------
   ✅ CORS configuration (يدعم Vercel + Railway + localhost) - تم التعديل
------------------------------------------------------------------- */

// قائمة الأصول (frontends) المسموح لها بالوصول إلى الـ Backend
const allowedOrigins = [
  'http://localhost:5173', // بيئة تطوير Vite
  'http://localhost:3000', // قد يكون للواجهة الأمامية المحلية أو لأدوات الاختبار
  'https://quiz-time-tan.vercel.app', // الرابط الفعلي للواجهة الأمامية على Vercel
  // أضف هنا أي روابط Vercel أخرى أو روابط مخصصة للواجهة الأمامية
];

// تهيئة CORS middleware بخيارات محددة
const corsOptions = {
  origin: (origin, callback) => {
    // السماح بالطلبات التي لا تحتوي على Origin (مثل Postman/curl للاختبار)
    // أو إذا كان الـ origin موجودًا في القائمة المسموح بها صراحةً
    // أو إذا كان ينتهي بـ .vercel.app (لأي deploy من Vercel)
    // أو إذا كان ينتهي بـ .up.railway.app (للتواصل الداخلي أو مشاريع Railway الأخرى)
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app') || origin.endsWith('.up.railway.app')) {
      callback(null, true);
    } else {
      // رفض الطلب إذا لم يكن Origin مسموحًا به
      console.warn(`CORS: Not allowed by origin policy - ${origin}`);
      callback(new Error(`Not allowed by CORS: ${origin}`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true, // مهم جداً إذا كنت ستستخدم ملفات تعريف الارتباط (cookies) أو رؤوس Authorization
  optionsSuccessStatus: 204, // رمز الحالة لنجاح طلب OPTIONS (Preflight)
};

// تفعيل CORS middleware في بداية التطبيق وقبل تعريف أي مسارات
app.use(cors(corsOptions));

/* ------------------------------------------------------------------
   Parsers & Uploads
------------------------------------------------------------------- */
app.use(express.json({ limit: '10mb' })); // لدعم JSON bodies
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // لدعم URL-encoded bodies

// إعداد Multer لتخزين الملفات في الذاكرة (مؤقت)
const upload = multer({ storage: multer.memoryStorage() });

/* ------------------------------------------------------------------
   🛡️ Schema للتحقق من صحة المدخلات باستخدام Joi
------------------------------------------------------------------- */
const settingsSchema = Joi.object({
  quizLanguage: Joi.string().valid('en', 'ar').default('en'),
  explanationLanguage: Joi.string().valid('en', 'ar').default('en'),
  difficulty: Joi.string().valid('easy', 'medium', 'hard').default('medium'),
  numMCQs: Joi.number().integer().min(0).max(50).default(0),
  numCases: Joi.number().integer().min(0).max(10).default(0),
  questionsPerCase: Joi.number().integer().min(0).max(10).default(0),
  numImageQuestions: Joi.number().integer().min(0).max(5).default(0),
  questionTypes: Joi.array().items(Joi.string().valid('MCQ', 'TrueFalse', 'ShortAnswer', 'Ordering', 'Matching')).default(['MCQ']),
  temperature: Joi.number().min(0).max(1).default(0.7),
  topP: Joi.number().min(0).max(1).default(0.9),
  topK: Joi.number().integer().min(1).max(100).default(40),
  additionalInstructions: Joi.string().allow('').optional(),
});

const quizRequestSchema = Joi.object({
  prompt: Joi.string().allow('').max(40000).optional(),
  settings: Joi.string().required(), // نتحقق هنا أنه string، وسنقوم بتحليله لاحقًا في الـ Controller
  imageUsage: Joi.string().valid('link', 'about', 'auto').optional().default('auto'),
});

// 🛡️ Middleware للتحقق من صحة المدخلات
const validateQuizRequest = (req, res, next) => {
  const { error } = quizRequestSchema.validate(req.body);
  if (error) {
    console.error('Validation Error:', error.details[0].message);
    return res.status(400).json({ error: `Validation failed: ${error.details[0].message}` });
  }

  // بعد التحقق الأساسي، نقوم بتحليل الـ settings JSON
  try {
    req.body.parsedSettings = JSON.parse(req.body.settings);
    // ثم نتحقق من صحة الـ parsedSettings
    const { error: settingsError } = settingsSchema.validate(req.body.parsedSettings);
    if (settingsError) {
      console.error('Settings Validation Error:', settingsError.details[0].message);
      return res.status(400).json({ error: `Settings validation failed: ${settingsError.details[0].message}` });
    }
  } catch (e) {
    console.error('JSON Parse Error for settings:', e.message);
    return res.status(400).json({ error: 'Invalid settings format. Settings must be valid JSON string.' });
  }

  next();
};


/* ------------------------------------------------------------------
   ثوابت لأنواع الأسئلة
------------------------------------------------------------------- */
const allQuestionTypes = [
  'MCQ',
  'TrueFalse',
  'ShortAnswer',
  'Ordering',
  'Matching',
];

/* ------------------------------------------------------------------
   Utils لمعالجة الملفات (تستقبل Buffer هنا)
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
   Schema لردّ Gemini (محدد بوضوح)
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
   Prompt Generator (مفصل وشامل لبروتوكول AI Execution Protocol)
------------------------------------------------------------------- */
const getGenerationPrompt = (
  prompt,
  subject,
  parsedSettings, // سنستخدم هذا مباشرة
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
1.  **Domain Inference:** Before generating any questions, perform a rapid internal analysis of the 'User Content'. Identify keywords, concepts, and typical structures to determine if it is:
    -   **Medical Content:** Characterized by medical terminology, diseases, treatments, anatomy, physiology, clinical cases, patient scenarios.
    -   **Engineering Content:** Characterized by technical specifications, design principles, calculations, systems, processes, materials, schematics.
    -   **General Science Content:** Characterized by scientific principles, theories, experiments, natural phenomena, formulas (but not necessarily complex engineering applications).
    -   **Other (Default):** If none of the above, treat it as general academic or factual content.
2.  **Role Adaptation:**
    -   **If Medical Content:** Adopt the role of an "expert medical examinations author specializing in the provided medical sub-domain (e.g., Gynecology, Cardiology, etc., infer from text if not explicit)". Focus on clinical reasoning, diagnosis, management, pathophysiology, and high-stakes information. Case Scenarios are highly applicable.
    -   **If Engineering Content:** Adopt the role of an "expert engineering examinations author specializing in the provided engineering sub-domain". Focus on problem-solving, application of formulas, system analysis, design considerations, and technical specifications. Case Scenarios might be less common but can be adapted for design problems or failure analysis.
    -   **If General Science Content:** Adopt the role of an "expert science educator". Focus on understanding concepts, principles, experimental design, and data interpretation. Case Scenarios are less common.
    -   **If Other (Default):** Adopt the role of a "general academic quiz master". Focus on factual recall, conceptual understanding, and logical inference.
3.  **Terminology and Tone:** Use domain-specific terminology accurately and maintain the appropriate academic/professional tone for the inferred domain. Avoid mixing terminologies or styles from different domains.
4.  **Absolute Prohibition of Textual References in Standalone Questions:**
    -   **Forbidden phrases in Question Stem (Standalone):** "According to the text", "Based on the provided content", "As per the document", "In the given text", "From the information provided", "According to the diagnostic criteria mentioned", "According to the study", "as mentioned in the text", "per the text", "as described in the text", "from the text", "in the text", "as per the information", "based on the information".
    -   **Sole Exception:** These phrases ARE allowed within Case Scenario questions to refer to the "case" itself (e.g., "Based on this case", "According to the patient's presentation"), NOT the general text.

# Protocol 1: Content Generation (Multi-Type Questions & Case Scenarios)
## Objective
Generate questions based on the user's configuration, strictly adhering to the inferred domain's rigor, terminology, and content sourcing, and **incorporating ALL requested question types.**

## Rules for Question Types (General):
1.  **Structure:** Each question must adhere to the specific structure of its \`questionType\`.
2.  **Content Adherence:** All parts of the question (stem, options, correct answer, distractors, case description) must be directly derived or logically inferred *only* from the provided content. No outside information.
3.  **Quality:** Use clear, precise domain-specific language. Avoid ambiguity.

## Specific Rules for Each Question Type:
1.  **MCQ (Multiple Choice Questions):**
    -   **Question Stem:** Clear, concise problem or mini-case.
    -   **Options:** Exactly 4 plausible options (A, B, C, D). One is the single best correct answer; three are plausible distractors.
    -   **\`correctAnswer\`:** The exact string of the correct option.
2.  **TrueFalse:**
    -   **Question Stem:** A statement that is either true or false based on the content.
    -   **Options:** Must be \`["True", "False"]\`.
    -   **\`correctAnswer\`:** Either "True" or "False".
3.  **ShortAnswer:**
    -   **Question Stem:** A direct question requiring a concise factual answer.
    -   **Options:** Empty array \`[]\`.
    -   **\`correctAnswer\`:** The precise factual string answer.
4.  **Ordering:**
    -   **Question Stem:** A prompt asking the user to arrange a list of items in a specific logical or chronological order.
    -   **Options:** An array of strings representing the items to be ordered (unshuffled).
    -   **\`correctAnswer\`:** An array of strings representing the items in the *correct* order.
5.  **Matching:**
    -   **Question Stem:** A prompt asking the user to match items from one list (prompts) to another (answers).
    -   **Options:** An array of strings representing the 'prompts' (e.g., definitions, terms).
    -   **\`matchOptions\`:** An array of strings representing the 'answers' (e.g., corresponding terms, concepts).
    -   **\`correctAnswer\`:** An array of objects \`[{ prompt: string, answer: string }]\` representing the correct pairs.

## Rules for Case Scenarios (Applicability depends on inferred domain):
1.  **Structure:** Each Case Scenario MUST be followed by 2 to 3 associated questions (of the requested types) based *solely* on that case.
2.  **Vignette/Scenario Description:** Detailed, realistic (3-8 lines) patient description for medical, or a detailed problem/system description for engineering/science. Include relevant context, data, or observations. Narration must be fluid and integrated.
3.  **Content Adherence (Vignette):** All details in the scenario description must be derived *only* from the provided content. You may invent non-factual scenario details (e.g., specific names, dates for context) to link concepts from the text, but you CANNOT invent domain-specific facts (diagnoses, specific results, treatments, technical specifications) not mentioned in the provided text.

# Protocol 2: Internal Answer Distribution Correction (Deterministic & Balanced)
## Objective
After generating all MCQs (including True/False treated as MCQs), you MUST internally analyze and modify the correct answer positions to ensure a deterministic and balanced distribution for MCQs (and True/False), minimizing excessive repetition of any single position within short ranges.

## Process (Step-by-Step Logic - Internal Execution for MCQ/TrueFalse):
1.  **Compile relevant MCQs:** Create an internal ordered list of ALL MCQs and True/False questions generated.
2.  **Iterate and Adjust:** Start analyzing from the 4th question in this compiled list (index 3 if 0-indexed).
    For each current question (let's call it question \`i\`, where \`i >= 3\`):
    a.  Define a 4-question window: Questions from \`i-3\` to \`i\`.
    b.  Count the frequency of each answer position (A, B, C, D) within this 4-question window. (For True/False, 'True' can be A, 'False' can be B).
    c.  Identify if any single answer position \`P\` has occurred more than twice in this window.
    d.  If such a position \`P\` is found:
        i.   Locate the *first* question \`j\` within the window (\`i-3 <= j <= i\`) whose correct answer position is \`P\`.
        ii.  Determine a \`NewPos\` (the deterministically optimized new position):
            1.  Calculate the frequency of each position (A, B, C, D) in the 4-question window *excluding* question \`j\` itself.
            2.  Find the position with the *lowest* frequency among the remaining positions.
            3.  If multiple positions have the same lowest frequency, choose the alphabetically earliest position (A before B, B before C, etc.).
            4.  This position is \`NewPos\`.
        iii. **Crucially:** Internally swap the *content* of the current correct option (at position \`P\`) with the *content* of the option at \`NewPos\` within question \`j\`'s options array.
        iv.  Update question \`j\`'s \`correctAnswer\` (string) to reflect the new option content at \`NewPos\`.
        v.   Update question \`j\`'s \`correctAnswerIndex\` to reflect the new index of \`NewPos\`.
        vi.  (Self-correction): Re-evaluate the window after this adjustment if needed for subsequent questions, ensuring the logic remains consistent.
    e.  Proceed to the next question (\`i+1\`) and repeat.
3.  **Ensure Full Balance:** Continue this process until the end of the compiled question list, guaranteeing a balanced and deterministic distribution of correct answers across all relevant questions.

# Final Generation Task
Based on the user's provided content and settings, and after performing the internal content generation and answer distribution correction, generate a single JSON object that strictly adheres to the provided schema. Do not include any extra text, formatting, or markdown backticks.

## User Configuration
- Subject: '${subject || 'the provided content'}'
- Quiz Language: ${parsedSettings.quizLanguage}
- Explanation Language: ${parsedSettings.explanationLanguage}
- Difficulty: '${parsedSettings.difficulty}'
- **Requested Question Types**: ${requestedQuestionTypesFormatted}
- **Standalone MCQs to Generate**: ${parsedSettings.numMCQs}
- **Case Scenarios to Generate**: ${parsedSettings.numCases}
- **MCQs per Case Scenario**: ${parsedSettings.questionsPerCase}
${
  parsedSettings.additionalInstructions
    ? `- Additional Instructions: "${parsedSettings.additionalInstructions}"`
    : ''
}

## User Content & Image Instructions
${mainContentPrompt}
${imageInstruction}`;
};

/* ------------------------------------------------------------------
   Health check (مسار عادي، لا يسبب TypeError)
------------------------------------------------------------------- */
app.get('/', (req, res) => {
  res.send('Quiz Time Backend API is running!');
});

/* ------------------------------------------------------------------
   /generate-quiz (مسار عادي، لا يسبب TypeError)
------------------------------------------------------------------- */
app.post(
  '/generate-quiz',
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'images', maxCount: 5 },
  ]),
  validateQuizRequest, // 🛡️ إضافة middleware التحقق من صحة المدخلات
  async (req, res) => {
    // 🛡️ تم التحقق من صحة prompt, settings, imageUsage بواسطة validateQuizRequest
    // و parsedSettings متاح الآن في req.body.parsedSettings
    const { prompt, imageUsage, parsedSettings } = req.body;
    const file =
      req.files && req.files['file'] ? req.files['file'][0] : null;
    const images = req.files && req.files['images'] ? req.files['images'] : [];

    // لم نعد نحتاج إلى JSON.parse(settings) هنا لأن validateQuizRequest قام بذلك
    // ولم نعد نحتاج إلى التحقق من صحة settings هنا لأن validateQuizRequest قام بذلك
    // ولم نعد نحتاج إلى التحقق من طول prompt هنا لأن validateQuizRequest قام بذلك (max(40000))

    const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
    const MAX_PDF_CHARS = 50000;
    const MAX_IMAGES = 5; // تم التحقق من عدد الصور بواسطة multer (maxCount: 5)
    const MAX_TOTAL_QUESTIONS = 50;

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

    // 🛡️ تم التحقق من عدد الصور بواسطة multer (maxCount: 5)
    // if (images.length > MAX_IMAGES) {
    //   return res
    //     .status(400)
    //     .json({ error: `Maximum ${MAX_IMAGES} images allowed.` });
    // }

    const totalMCQs = parsedSettings.numMCQs || 0;
    const totalCases = parsedSettings.numCases || 0;
    const qPerCase = parsedSettings.questionsPerCase || 0;
    const totalImageQuestions = parsedSettings.numImageQuestions || 0;
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
      const { ai, key } = getGeminiAIInstance(); // استخدام مدير المفاتيح
      aiInstance = ai;
      usedKey = key;

      const generationPrompt = getGenerationPrompt(
        prompt,
        null, // Subject
        parsedSettings, // استخدام parsedSettings مباشرة
        fileContent,
        images.length,
        imageUsage // تمرير imageUsage هنا
      );

      const promptParts = [{ text: generationPrompt }];
      for (const img of images) {
        promptParts.push(await fileToGenerativePart(img.buffer, img.mimetype));
      }

      // 🚀 تحديث: استخدام GoogleGenerativeAI مباشرة
      const model = aiInstance.getGenerativeModel({
        model: 'gemini-2.5-flash', // استخدام الموديل المحدد
      });

      const response = await model.generateContent({
        contents: [{ role: 'user', parts: promptParts }], // 🚀 تحديث: تنسيق المحتوى لـ @google/genai
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
              processedQuestion.isFlawed = true; // لو كان مش string يبقي فيه مشكلة
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

      updateApiKeyStatus(usedKey, true); // تحديث حالة المفتاح بنجاح
      return res
        .status(200)
        .json({ ...parsedQuiz, quizData: processedQuizData });
    } catch (error) {
      console.error('Gemini API call failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (usedKey) updateApiKeyStatus(usedKey, false, errorMessage); // تحديث حالة المفتاح بالفشل

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
      if (errorMessage.includes('503') || errorMessage.includes('temporarily unavailable')) {
        return res
          .status(503)
          .json({ error: 'AI service unavailable. Please try again later.' });
      }
      if (errorMessage.includes('No Gemini API key')) {
        return res
          .status(500)
          .json({ error: errorMessage + ' All keys are currently unavailable. Please try again later.' });
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

  [file content end]
