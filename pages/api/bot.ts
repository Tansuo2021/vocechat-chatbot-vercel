import { Message } from '@/types/vocechat';
import { OPENAI_API_HOST, OPENAI_ORGANIZATION, VOCECHAT_BOT_SECRET, VOCECHAT_BOT_ID, VOCECHAT_ORIGIN } from '@/utils/app/const';

export const config = {
    runtime: 'edge',
};

const log = (message: string, data?: any) => {
    console.log(`[${new Date().toISOString()}] ${message}`, data ? JSON.stringify(data) : '');
};

const measureTime = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    const result = await fn();
    const duration = Date.now() - start;
    log(`${name} took ${duration}ms`);
    return result;
};

const fetchWithTimeout = async (url: string, options: RequestInit, timeout = 30000): Promise<Response> => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
};

const fetchWithRetry = async (url: string, options: RequestInit, maxRetries = 3): Promise<Response> => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fetchWithTimeout(url, options);
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(res => setTimeout(res, 1000 * Math.pow(2, i)));
        }
    }
    throw new Error("Max retries reached");
};

const sendMessageToBot = async (url: string, message: string): Promise<void> => {
    try {
        const resp = await fetchWithRetry(url, {
            method: "POST",
            headers: {
                "content-type": "text/markdown",
                "x-api-key": VOCECHAT_BOT_SECRET,
            },
            body: message,
        });
        const jsonResp = await resp.json();
        log("bot: send successfully", jsonResp);
    } catch (error) {
        log("bot: send failed", { url, error });
        throw error;
    }
};

const processMessageContent = (content: string): string => {
    return content.replace(/@[0-9]+/g, "").trim();
};

const getImageBase64 = async (imageUrl: string, contentType: string): Promise<string> => {
    const response = await fetch(imageUrl);
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return `data:${contentType};base64,${base64}`;
};


const isImageMessage = (message: Message): boolean => {
    return message.detail.content_type === "vocechat/file" && 
           message.detail.properties &&
           'content_type' in message.detail.properties &&
           typeof (message.detail.properties as any).content_type === 'string' &&
           (message.detail.properties as any).content_type.startsWith('image/');
};


const processMessage = async (message: Message): Promise<string> => {
    const TEXT_MODEL = process.env.DEFAULT_MODEL || "gpt-3.5-turbo";
    const IMAGE_MODEL = process.env.DEFAULT_MODEL || "claude-3-5-sonnet-20240620";
    const API_HOST = process.env.OPENAI_API_HOST || "https://api.openai.com";

    let requestBody: any;

   if (isImageMessage(message)) {
    // 处理图片消息
    const filePath = message.detail.content;
    const imageUrl = `${VOCECHAT_ORIGIN}/api/resource/file?file_path=${encodeURIComponent(filePath)}`;
    const contentType = (message.detail.properties as any).content_type;

    try {
        const imageBase64 = await getImageBase64(imageUrl, contentType);

        requestBody = {
            max_tokens: 4096,
            model: IMAGE_MODEL,
            messages: [
                {
                    role: "system",
                    content: "You are GPT, a large language model trained by 探索分享. 回答全部用markdown格式。"
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "这个图片描述了什么？请详细分析。"
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: imageBase64
                            }
                        }
                    ]
                }
            ],
            stream: false
        };
    } catch (error) {
        log("Error fetching or converting image", error);
        return "抱歉，我在处理图片时遇到了问题。请稍后再试或联系支持人员。";
    }
} else {
        // 处理文本消息
        const prompt = processMessageContent(message.detail.content);

        requestBody = {
            model: TEXT_MODEL,
            messages: [
                {
                    role: 'system',
                    content: "You are an AI assistant. Answer the user's question concisely and accurately.",
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            max_tokens: 2000,
            temperature: 1,
            stream: false,
        };
    }

    try {
        const aiResp = await measureTime("AI API call", () => 
            fetchWithRetry(`${API_HOST}/v1/chat/completions`, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                },
                method: 'POST',
                body: JSON.stringify(requestBody),
            })
        );

        const aiData = await aiResp.json();
        if (!aiData.choices || !aiData.choices[0] || !aiData.choices[0].message) {
            throw new Error("Unexpected API response format");
        }
        return aiData.choices[0].message.content.trim();
     } catch (error) {
    log("Error calling OpenAI API", error);
    console.error("Full error object:", JSON.stringify(error, null, 2));
    if (isImageMessage(message)) {
        return "抱歉，我在处理图片时遇到了问题。请稍后再试或联系支持人员。";
    } else {
        return "抱歉，我现在无法处理您的请求。请稍后再试。";
    }
}

};

let messageQueue: Message[] = [];
let processingPromise: Promise<void> | null = null;

const processQueueParallel = async (maxConcurrent: number = 3): Promise<void> => {
    while (messageQueue.length > 0) {
        const batch = messageQueue.splice(0, maxConcurrent);
        await Promise.all(batch.map(async (message) => {
            try {
                const response = await processMessage(message);
                const url = `${VOCECHAT_ORIGIN}/api/bot/reply/${message.mid}`;
                await sendMessageToBot(url, response);
            } catch (error) {
                log("Error processing message", error);
                // 如果处理消息时出错，我们可以选择发送一个错误消息给用户
                const errorMessage = "抱歉，处理您的消息时出现了问题。请稍后再试。";
                const url = `${VOCECHAT_ORIGIN}/api/bot/reply/${message.mid}`;
                try {
                    await sendMessageToBot(url, errorMessage);
                } catch (sendError) {
                    log("Error sending error message to user", sendError);
                }
            }
        }));
    }
    processingPromise = null;
};

const handler = async (req: Request): Promise<Response> => {
    log("bot: from webhook push", { method: req.method, VOCECHAT_BOT_ID, VOCECHAT_ORIGIN, VOCECHAT_BOT_SECRET: VOCECHAT_BOT_SECRET.slice(-5) });

    if (req.method === "POST") {
        try {
            const data = await req.json() as Message;
            log("bot: handler POST", data);

            if (data.from_uid == VOCECHAT_BOT_ID) {
                return new Response(`ignore sent by bot self`, { status: 200 });
            }

            if ('gid' in data.target) {
                const mentions = (data.detail.properties ?? {}).mentions ?? [];
                const mentionedAtGroup = mentions.some(m => m == VOCECHAT_BOT_ID) || 
                                         data.detail.content.includes(`@${VOCECHAT_BOT_ID}`) ||
                                         data.detail.content.toLowerCase().includes('@chatgpt');
                if (!mentionedAtGroup) {
                    return new Response(`ignore not mention at group`, { status: 200 });
                }
            }

            messageQueue.push(data);

            if (!processingPromise) {
                processingPromise = processQueueParallel();
            }

            return new Response(`Message queued`, { status: 200 });
        } catch (error) {
            log("Error processing POST request", error);
            return new Response(`Error processing request`, { status: 500 });
        }
    } else if (req.method === "GET") {
        return new Response(`GET: bot resp`, { status: 200 });
    } else {
        return new Response(`${req.method}: bot resp`, { status: 405 });
    }
};

export default handler;
