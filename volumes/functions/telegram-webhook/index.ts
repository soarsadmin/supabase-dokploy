import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

export default {
  async fetch(req: Request) {
    const update = await req.json();

    const message = update.message;
    const text = message?.text;
    const chatId = message?.chat?.id;
    const userId = message?.from?.id;

    if (!text || !chatId || !userId) {
      return Response.json({ ok: true, ignored: true });
    }

    const analysis = await analyzeTask(text);

    if (!analysis.ready_to_save) {
      const { error } = await supabase.from("pending_task_drafts").insert({
        telegram_chat_id: chatId,
        telegram_user_id: userId,
        source_message_id: message.message_id,
        draft_payload: analysis.task,
        missing_fields: analysis.missing_fields,
      });

      if (error) {
        return Response.json({ ok: false, error: error.message }, { status: 500 });
      }

      await sendTelegramMessage(chatId, analysis.question ?? "請補充資料。");
      return Response.json({ ok: true, saved_to: "pending_task_drafts" });
    }

    const { error } = await supabase.from("tasks").insert({
      title: analysis.task.title,
      description: analysis.task.description,
      status: analysis.task.status,
      owner_telegram_user_id: analysis.task.owner_telegram_user_id,
      due_date: analysis.task.due_date,
      source_chat_id: chatId,
      source_message_id: message.message_id,
    });

    if (error) {
      return Response.json({ ok: false, error: error.message }, { status: 500 });
    }

    await sendTelegramMessage(chatId, `已建立任務：${analysis.task.title}`);
    return Response.json({ ok: true, saved_to: "tasks" });
  },
};

async function sendTelegramMessage(chatId: number, text: string) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");

  if (!token) {
    console.log("TELEGRAM_BOT_TOKEN is not set. Skipping Telegram reply.");
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Telegram sendMessage failed: ${response.status} ${errorBody}`);
  }
}

async function analyzeTask(text: string) {
  const hasDueDate =
    text.includes("今日") ||
    text.includes("明日") ||
    text.includes("週五") ||
    text.includes("星期五");

  return {
    is_task: true,
    ready_to_save: hasDueDate,
    missing_fields: hasDueDate ? [] : ["due_date"],
    question: hasDueDate ? null : "收到，這似乎是一個任務。想幾時完成？",
    task: {
      title: text,
      description: null,
      owner_telegram_user_id: null,
      due_date: hasDueDate ? "2026-09-11" : null,
      priority: "medium",
      status: "todo",
    },
  };
}
