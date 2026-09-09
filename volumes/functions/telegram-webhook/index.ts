import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type Priority = "low" | "medium" | "high";
type TaskStatus = "todo" | "in_progress" | "done";

type TaskDraft = {
  title: string | null;
  description: string | null;
  owner_telegram_user_id: number | null;
  due_date: string | null;
  priority: Priority;
  status: TaskStatus;
};

type PendingTaskDraftRow = {
  id: string;
  draft_payload: TaskDraft;
  missing_fields: string[];
};

type AiAnalysis = {
  is_task: boolean;
  ready_to_save: boolean;
  missing_fields: string[];
  question: string | null;
  task: TaskDraft;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

export default {
  async fetch(req: Request) {
    try {
      const update = await req.json();
      const message = update.message;
      const text = message?.text?.trim();
      const chatId = message?.chat?.id;
      const userId = message?.from?.id;
      const messageId = message?.message_id;

      if (!text || !chatId || !userId) {
        return Response.json({ ok: true, ignored: true });
      }

      if (text === "/cancel" || text === "取消") {
        await deletePendingDraftsForUser(chatId, userId);
        await sendTelegramMessage(chatId, "已取消目前未完成的任務草稿。");
        return Response.json({ ok: true, cancelled: true });
      }

      const existingDraft = await findPendingDraft(chatId, userId);
      const analysis = await analyzeTaskWithAi({
        text,
        userId,
        existingDraft: existingDraft?.draft_payload ?? null,
        today: getTodayInHongKong(),
      });

      if (!analysis.is_task) {
        await sendTelegramMessage(chatId, "收到。不過我暫時判斷這不是一個任務，所以未有寫入。");
        return Response.json({ ok: true, ignored: "not_a_task" });
      }

      if (!analysis.ready_to_save) {
        await savePendingDraft({
          draftId: existingDraft?.id ?? null,
          chatId,
          userId,
          messageId,
          analysis,
        });

        if (existingDraft) {
          await deleteOlderPendingDrafts(chatId, userId, existingDraft.id);
        }

        await sendTelegramMessage(chatId, analysis.question ?? buildFallbackQuestion(analysis.missing_fields));
        return Response.json({
          ok: true,
          saved_to: "pending_task_drafts",
          missing_fields: analysis.missing_fields,
        });
      }

      const { error: insertError } = await supabase.from("tasks").insert({
        title: analysis.task.title,
        description: analysis.task.description,
        status: analysis.task.status,
        priority: analysis.task.priority,
        owner_telegram_user_id: analysis.task.owner_telegram_user_id ?? userId,
        due_date: analysis.task.due_date,
        source_chat_id: chatId,
        source_message_id: messageId,
      });

      if (insertError) {
        throw insertError;
      }

      await deletePendingDraftsForUser(chatId, userId);

      await sendTelegramMessage(chatId, buildTaskSavedMessage(analysis.task));
      return Response.json({ ok: true, saved_to: "tasks" });
    } catch (error) {
      console.error(error);
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 },
      );
    }
  },
};

async function findPendingDraft(
  chatId: number,
  userId: number,
): Promise<PendingTaskDraftRow | null> {
  const { data, error } = await supabase
    .from("pending_task_drafts")
    .select("id,draft_payload,missing_fields")
    .eq("telegram_chat_id", chatId)
    .eq("telegram_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as PendingTaskDraftRow | null;
}

async function savePendingDraft(input: {
  draftId: string | null;
  chatId: number;
  userId: number;
  messageId: number;
  analysis: AiAnalysis;
}) {
  const payload = {
    telegram_chat_id: input.chatId,
    telegram_user_id: input.userId,
    source_message_id: input.messageId,
    draft_payload: input.analysis.task,
    missing_fields: input.analysis.missing_fields,
  };

  const result = input.draftId
    ? await supabase.from("pending_task_drafts").update(payload).eq("id", input.draftId)
    : await supabase.from("pending_task_drafts").insert(payload);

  if (result.error) {
    throw result.error;
  }
}

async function deleteOlderPendingDrafts(chatId: number, userId: number, keepDraftId: string) {
  const { error } = await supabase
    .from("pending_task_drafts")
    .delete()
    .eq("telegram_chat_id", chatId)
    .eq("telegram_user_id", userId)
    .neq("id", keepDraftId);

  if (error) {
    throw error;
  }
}

async function deletePendingDraftsForUser(chatId: number, userId: number) {
  const { error } = await supabase
    .from("pending_task_drafts")
    .delete()
    .eq("telegram_chat_id", chatId)
    .eq("telegram_user_id", userId);

  if (error) {
    throw error;
  }
}

async function analyzeTaskWithAi(input: {
  text: string;
  userId: number;
  existingDraft: TaskDraft | null;
  today: string;
}): Promise<AiAnalysis> {
  const ollamaBaseUrl = Deno.env.get("OLLAMA_BASE_URL") ?? "http://host.docker.internal:11434";
  const ollamaModel = Deno.env.get("OLLAMA_MODEL") ?? "llama3.1:8b";
  const ollamaApiKey = Deno.env.get("OLLAMA_API_KEY");

  const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ollamaApiKey ? { Authorization: `Bearer ${ollamaApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: ollamaModel,
      stream: false,
      format: "json",
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(input.today),
        },
        {
          role: "user",
          content: JSON.stringify({
            latest_message: input.text,
            telegram_user_id: input.userId,
            existing_draft: input.existingDraft,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama request failed: ${response.status} ${body}`);
  }

  const ollamaResult = await response.json();
  const content = ollamaResult?.message?.content;
  const parsed = parseJsonObject(content);

  return normalizeAnalysis(parsed, input);
}

function buildSystemPrompt(today: string) {
  return `
You are a project-management intake assistant for a small company.
Today is ${today}.

Your job:
1. Decide whether the user's message is a task/request.
2. Merge the latest message with existing_draft when present.
3. Ask ONE short follow-up question in Traditional Chinese when required information is missing.
4. Only set ready_to_save=true when the task has enough data to create a task record.

Required fields before saving:
- title: short action-oriented task title
- due_date: ISO date YYYY-MM-DD

Optional fields:
- description
- priority: low, medium, high
- status: todo, in_progress, done

Rules:
- Output JSON only. No Markdown.
- If date is relative, convert it to YYYY-MM-DD using today.
- If owner is unclear, use telegram_user_id as owner_telegram_user_id.
- Keep Cantonese/Traditional Chinese wording in title, description, and question.
- missing_fields must contain field names only.

Return this exact JSON shape:
{
  "is_task": true,
  "ready_to_save": false,
  "missing_fields": ["due_date"],
  "question": "想幾時完成？",
  "task": {
    "title": "任務標題",
    "description": null,
    "owner_telegram_user_id": 123,
    "due_date": null,
    "priority": "medium",
    "status": "todo"
  }
}
`.trim();
}

function getTodayInHongKong() {
  const hongKongOffsetMs = 8 * 60 * 60 * 1000;
  return new Date(Date.now() + hongKongOffsetMs).toISOString().slice(0, 10);
}

function parseJsonObject(content: unknown): Record<string, unknown> {
  if (typeof content !== "string") {
    throw new Error("Ollama did not return message.content");
  }

  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Ollama did not return valid JSON");
    }

    return JSON.parse(match[0]);
  }
}

function normalizeAnalysis(raw: Record<string, unknown>, input: {
  text: string;
  userId: number;
  existingDraft: TaskDraft | null;
}): AiAnalysis {
  const rawTask = isRecord(raw.task) ? raw.task : {};
  const task: TaskDraft = {
    title: stringOrNull(rawTask.title) ?? input.existingDraft?.title ?? input.text,
    description: stringOrNull(rawTask.description) ?? input.existingDraft?.description ?? null,
    owner_telegram_user_id: numberOrNull(rawTask.owner_telegram_user_id) ?? input.userId,
    due_date: dateOrNull(rawTask.due_date) ?? input.existingDraft?.due_date ?? null,
    priority: priorityOrDefault(rawTask.priority, input.existingDraft?.priority ?? "medium"),
    status: statusOrDefault(rawTask.status, input.existingDraft?.status ?? "todo"),
  };

  const missingFields = Array.isArray(raw.missing_fields)
    ? raw.missing_fields.filter((field): field is string => typeof field === "string")
    : [];

  if (!task.title) {
    missingFields.push("title");
  }

  if (!task.due_date) {
    missingFields.push("due_date");
  }

  const uniqueMissingFields = [...new Set(missingFields)];
  const readyToSave = uniqueMissingFields.length === 0 && Boolean(task.title && task.due_date);

  return {
    is_task: raw.is_task !== false,
    ready_to_save: readyToSave,
    missing_fields: uniqueMissingFields,
    question: stringOrNull(raw.question),
    task,
  };
}

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

function buildTaskSavedMessage(task: TaskDraft) {
  const dueDate = task.due_date ? `\n期限：${task.due_date}` : "";
  return `已建立任務：${task.title}${dueDate}`;
}

function buildFallbackQuestion(missingFields: string[]) {
  if (missingFields.includes("due_date")) {
    return "收到，這是一個任務。想幾時完成？";
  }

  if (missingFields.includes("title")) {
    return "收到。可以講多少少要做甚麼嗎？";
  }

  return "收到。可以補充多少少資料嗎？";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateOrNull(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function priorityOrDefault(value: unknown, fallback: Priority): Priority {
  return value === "low" || value === "medium" || value === "high" ? value : fallback;
}

function statusOrDefault(value: unknown, fallback: TaskStatus): TaskStatus {
  return value === "todo" || value === "in_progress" || value === "done" ? value : fallback;
}
