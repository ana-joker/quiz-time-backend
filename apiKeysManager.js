// apiKeysManager.js
const { GoogleGenerativeAI } = require('@google/generative-ai');

// الحصول على المفاتيح من متغيرات البيئة وتقسيمها إلى مصفوفة
const ALL_API_KEYS = (process.env.GEMINI_API_KEYS || '').split(',').map(key => key.trim()).filter(key => key.length > 0);

if (ALL_API_KEYS.length === 0) {
    console.error("CRITICAL ERROR: No Gemini API keys found in GEMINI_API_KEYS environment variable. Please set at least one key.");
    process.exit(1); // إيقاف التطبيق إذا لم يتم العثور على مفاتيح
}

let currentKeyIndex = 0;
// لتتبع حالة المفاتيح (متاح، غير متاح مؤقتًا، وقت إعادة التفعيل)
const keyStatus = ALL_API_KEYS.map(key => ({
    key: key,
    available: true,
    retryAfter: 0 // timestamp when key can be retried
}));

const RETRY_DELAY_MS = 5 * 60 * 1000; // 5 دقائق قبل إعادة محاولة مفتاح فشل بسبب تجاوز الحد

/**
 * يختار مفتاح API متاح حاليًا بنظام Round-Robin.
 * إذا لم يكن هناك مفتاح متاح، يرفع خطأ.
 * @returns {string} مفتاح API متاح.
 */
function getAvailableApiKey() {
    const startIndex = currentKeyIndex;
    let foundKey = null;
    let attempts = 0;

    while (attempts < keyStatus.length) {
        const status = keyStatus[currentKeyIndex];
        const now = Date.now();

        if (status.available || status.retryAfter <= now) {
            // إذا كان المفتاح متاحًا أو انتهى وقت الانتظار
            status.available = true; // نعتبره متاحًا الآن
            status.retryAfter = 0;
            foundKey = status.key;
            break;
        }

        currentKeyIndex = (currentKeyIndex + 1) % keyStatus.length;
        attempts++;

        if (currentKeyIndex === startIndex) {
            // لفة كاملة ولم نجد مفتاح متاح
            break;
        }
    }

    if (!foundKey) {
        throw new Error("No Gemini API key is currently available. All keys are either rate-limited or marked as temporarily unavailable. Please try again later.");
    }

    currentKeyIndex = (currentKeyIndex + 1) % keyStatus.length; // الانتقال للمفتاح التالي للطلب القادم
    return foundKey;
}

/**
 * يقوم بتحديث حالة المفتاح بعد استخدام الطلب.
 * @param {string} keyInUse المفتاح الذي تم استخدامه.
 * @param {boolean} success هل الطلب نجح؟
 * @param {string} [errorMessage] رسالة الخطأ إذا فشل.
 */
function updateApiKeyStatus(keyInUse, success, errorMessage = '') {
    const statusEntry = keyStatus.find(entry => entry.key === keyInUse);
    if (!statusEntry) return;

    if (success) {
        statusEntry.available = true;
        statusEntry.retryAfter = 0;
    } else if (errorMessage.includes('rate limit') || errorMessage.includes('quota exceeded') || errorMessage.includes('429')) {
        // إذا كان الخطأ بسبب تجاوز الحد
        statusEntry.available = false;
        statusEntry.retryAfter = Date.now() + RETRY_DELAY_MS;
        console.warn(`Gemini API Key ending with ...${keyInUse.slice(-5)} is rate-limited. Will retry after ${RETRY_DELAY_MS / 1000 / 60} minutes.`);
    } else {
        // لأي أخطاء أخرى غير تجاوز الحد، نعتبر المفتاح متاحًا ولكن ننبه
        console.error(`Gemini API Key ending with ...${keyInUse.slice(-5)} failed with non-rate-limit error: ${errorMessage}. Keeping key available.`);
        statusEntry.available = true; // قد تكون مشكلة مؤقتة أو مشكلة في الطلب نفسه
    }
}

/**
 * يقوم بإنشاء مثيل GoogleGenerativeAI مع مفتاح API متاح.
 * @returns {GoogleGenerativeAI}
 */
function getGeminiAIInstance() {
    const apiKey = getAvailableApiKey();
    return {
        ai: new GoogleGenerativeAI(apiKey),
        key: apiKey // نرجع المفتاح المستخدم لتتبع حالته
    };
}

module.exports = {
    getGeminiAIInstance,
    updateApiKeyStatus,
    ALL_API_KEYS_COUNT: ALL_API_KEYS.length // لتسهيل معرفة عدد المفاتيح المتاحة
};