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

type TaskRow = TaskDraft & {
  id: string;
  created_at: string;
};

type TaskUpdateFields = Partial<Pick<TaskDraft, "title" | "due_date" | "status" | "priority" | "description">>;

type AiTaskListRequest = {
  status: TaskStatus | null;
  due_date: string | null;
  priority: Priority | null;
  search_text: string | null;
  open_only: boolean;
  include_pending: boolean;
  limit: number;
};

type AiTaskUpdateRequest = {
  target_task_number: number | null;
  target_search_text: string | null;
  fields: TaskUpdateFields;
  clarification_question: string | null;
};

type AiAnalysis = {
  is_task: boolean;
  ready_to_save: boolean;
  missing_fields: string[];
  question: string | null;
  task: TaskDraft;
};

type AiCommand = {
  action: "create" | "list" | "update" | "other";
  reply: string | null;
  list: AiTaskListRequest | null;
  update: AiTaskUpdateRequest | null;
  create: AiAnalysis | null;
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

      const today = getTodayInHongKong();
      const existingDraft = await findPendingDraft(chatId, userId);
      const recentTasks = await fetchTasksForChat(chatId, 10);
      const command = await analyzeUserCommandWithAi({
        text,
        userId,
        existingDraft: existingDraft?.draft_payload ?? null,
        recentTasks,
        today,
      });

      if (command.action === "list") {
        const reply = await buildTasksReplyFromAi(chatId, userId, command.list);
        await sendTelegramMessage(chatId, reply);
        return Response.json({ ok: true, listed: command.list });
      }

      if (command.action === "update") {
        const reply = await updateTaskFromAiCommand(chatId, command.update, recentTasks);
        await sendTelegramMessage(chatId, reply);
        return Response.json({ ok: true, updated: command.update });
      }

      if (command.action === "other") {
        await sendTelegramMessage(chatId, command.reply ?? "收到。不過我暫時未能判斷要新增、列出，還是修改任務。");
        return Response.json({ ok: true, ignored: "other" });
      }

      const analysis = command.create ?? await analyzeTaskWithAi({
        text,
        userId,
        existingDraft: existingDraft?.draft_payload ?? null,
        today,
      });
      applyRelativeWeekdayOverrideToAnalysis(analysis, text, today);

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

async function buildPendingDraftsReply(chatId: number, userId: number) {
  const { data, error } = await supabase
    .from("pending_task_drafts")
    .select("id,draft_payload,missing_fields")
    .eq("telegram_chat_id", chatId)
    .eq("telegram_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    throw error;
  }

  const drafts = (data ?? []) as PendingTaskDraftRow[];
  if (drafts.length === 0) {
    return "暫時沒有未完成草稿。";
  }

  return [
    "未完成草稿：",
    ...drafts.map((draft, index) => {
      const title = draft.draft_payload?.title ?? "未命名任務";
      const missing = draft.missing_fields.length > 0 ? `，欠：${draft.missing_fields.join(", ")}` : "";
      return `${index + 1}. ${title}${missing}`;
    }),
  ].join("\n");
}

async function fetchTasksForChat(chatId: number, limit = 10) {
  const { data, error } = await supabase
    .from("tasks")
    .select("id,title,description,status,priority,owner_telegram_user_id,due_date,created_at")
    .eq("source_chat_id", chatId)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (data ?? []) as TaskRow[];
}

async function analyzeUserCommandWithAi(input: {
  text: string;
  userId: number;
  existingDraft: TaskDraft | null;
  recentTasks: TaskRow[];
  today: string;
}): Promise<AiCommand> {
  const raw = await callOllamaJson([
    {
      role: "system",
      content: buildCommandSystemPrompt(input.today),
    },
    {
      role: "user",
      content: JSON.stringify({
        latest_message: input.text,
        telegram_user_id: input.userId,
        existing_draft: input.existingDraft,
        recent_tasks: input.recentTasks.map((task, index) => ({
          number: index + 1,
          id: task.id,
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          due_date: task.due_date,
        })),
      }),
    },
  ]);

  return normalizeCommand(raw, input);
}

async function buildTasksReplyFromAi(chatId: number, userId: number, request: AiTaskListRequest | null) {
  const listRequest = request ?? defaultListRequest();

  if (listRequest.include_pending) {
    return buildPendingDraftsReply(chatId, userId);
  }

  let query = supabase
    .from("tasks")
    .select("id,title,description,status,priority,owner_telegram_user_id,due_date,created_at")
    .eq("source_chat_id", chatId);

  if (listRequest.status) {
    query = query.eq("status", listRequest.status);
  }

  if (listRequest.open_only) {
    query = query.neq("status", "done");
  }

  if (listRequest.priority) {
    query = query.eq("priority", listRequest.priority);
  }

  if (listRequest.due_date) {
    query = query.eq("due_date", listRequest.due_date);
  }

  if (listRequest.search_text) {
    query = query.ilike("title", `%${escapeLikePattern(listRequest.search_text)}%`);
  }

  const { data, error } = await query
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(listRequest.limit);

  if (error) {
    throw error;
  }

  const tasks = (data ?? []) as TaskRow[];
  if (tasks.length === 0) {
    return "找不到符合條件的任務。";
  }

  return [
    "符合條件的任務：",
    ...tasks.map((task, index) => formatTaskLine(task, index + 1)),
  ].join("\n");
}

async function updateTaskFromAiCommand(
  chatId: number,
  request: AiTaskUpdateRequest | null,
  recentTasks: TaskRow[],
) {
  if (!request) {
    return "你想修改哪一個任務？可以例如講：「把 pricing page 改到星期五」。";
  }

  const fields = normalizeUpdateFields(request.fields);
  if (Object.keys(fields).length === 0) {
    return request.clarification_question ?? "你想修改甚麼資料？可以改題目、日期、狀態、優先級或描述。";
  }

  const task = findTaskToUpdate(recentTasks, request);
  if (!task) {
    return request.clarification_question ?? "我找不到要修改哪一個任務。你可以講任務名稱，或者先輸入「列出任務」。";
  }

  const { data, error } = await supabase
    .from("tasks")
    .update(fields)
    .eq("source_chat_id", chatId)
    .eq("id", task.id)
    .select("id,title,description,status,priority,owner_telegram_user_id,due_date,created_at")
    .single();

  if (error) {
    throw error;
  }

  return `已更新：\n${formatTaskLine(data as TaskRow, recentTasks.indexOf(task) + 1)}`;
}

function findTaskToUpdate(recentTasks: TaskRow[], request: AiTaskUpdateRequest) {
  if (request.target_task_number) {
    return recentTasks[request.target_task_number - 1] ?? null;
  }

  if (!request.target_search_text) {
    return null;
  }

  const searchText = request.target_search_text.toLowerCase();
  const matchedTasks = recentTasks.filter((task) =>
    task.title?.toLowerCase().includes(searchText) ||
    task.description?.toLowerCase().includes(searchText)
  );

  return matchedTasks.length === 1 ? matchedTasks[0] : null;
}

function buildCommandSystemPrompt(today: string) {
  const dateReference = buildDateReference(today);

  return `
You are the command router for a Telegram project-management bot.
Today is ${today}.
${dateReference}

Decide whether the latest message wants to create a task, list tasks, update a task, or is unrelated.
Use recent_tasks to resolve natural references like "第二個", "pricing page", "deadline", "今日未完成".
Use existing_draft only when the user is answering a follow-up question for a new task.

Important rules:
- Output JSON only. No Markdown.
- Convert relative dates to YYYY-MM-DD using today.
- Do not calculate weekdays yourself. Use the provided date reference for phrases like 今個星期五, 這個星期五, 下星期一, 下週三.
- Never invent a task id. For update, use target_task_number from recent_tasks when possible.
- If update target is ambiguous, set action="update", leave target fields null, and set clarification_question.
- For list, translate the user's conditions into status, due_date, priority, search_text, open_only, include_pending, and limit.
- If the user asks for open/unfinished/未完成 tasks, use open_only=true instead of status="todo".
- If the user asks for drafts, pending tasks, unfinished draft, or messages waiting for clarification, set include_pending=true.
- For create, return the same create object used by the task intake flow.
- Use Traditional Chinese/Cantonese for reply, question, title, and description.

Examples:
- "今日有咩未完成？" => action=list, due_date=today, open_only=true.
- "列出 pricing 相關任務" => action=list, search_text="pricing".
- "把 pricing page 改到星期五" => action=update, choose the matching recent_tasks number, fields.due_date=that Friday.
- "第二個做完" => action=update, target_task_number=2, fields.status="done".
- "記低星期五前改 pricing page" => action=create.

Return this exact JSON shape:
{
  "action": "list",
  "reply": null,
  "list": {
    "status": null,
    "due_date": null,
    "priority": null,
    "search_text": null,
    "open_only": false,
    "include_pending": false,
    "limit": 10
  },
  "update": {
    "target_task_number": null,
    "target_search_text": null,
    "fields": {
      "title": null,
      "description": null,
      "due_date": null,
      "status": null,
      "priority": null
    },
    "clarification_question": null
  },
  "create": {
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
}
`.trim();
}

function normalizeCommand(raw: Record<string, unknown>, input: {
  text: string;
  userId: number;
  existingDraft: TaskDraft | null;
  today: string;
}): AiCommand {
  const action = raw.action === "list" || raw.action === "update" || raw.action === "other"
    ? raw.action
    : "create";

  const command: AiCommand = {
    action,
    reply: stringOrNull(raw.reply),
    list: normalizeListRequest(raw.list),
    update: normalizeAiUpdateRequest(raw.update),
    create: isRecord(raw.create)
      ? normalizeAnalysis(raw.create, {
        text: input.text,
        userId: input.userId,
        existingDraft: input.existingDraft,
      })
      : null,
  };

  applyRelativeWeekdayOverrideToCommand(command, input.text, input.today);
  return command;
}

function normalizeListRequest(value: unknown): AiTaskListRequest | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    status: statusOrNull(value.status),
    due_date: dateOrNull(value.due_date),
    priority: priorityOrNull(value.priority),
    search_text: stringOrNull(value.search_text),
    open_only: value.open_only === true,
    include_pending: value.include_pending === true,
    limit: limitOrDefault(value.limit, 10),
  };
}

function normalizeAiUpdateRequest(value: unknown): AiTaskUpdateRequest | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    target_task_number: taskNumberOrNull(value.target_task_number),
    target_search_text: stringOrNull(value.target_search_text),
    fields: normalizeUpdateFields(isRecord(value.fields) ? value.fields : {}),
    clarification_question: stringOrNull(value.clarification_question),
  };
}

function normalizeUpdateFields(fields: Record<string, unknown> | TaskUpdateFields): TaskUpdateFields {
  const normalizedFields: TaskUpdateFields = {};
  const title = stringOrNull(fields.title);
  const description = stringOrNull(fields.description);
  const dueDate = dateOrNull(fields.due_date);
  const status = statusOrNull(fields.status);
  const priority = priorityOrNull(fields.priority);

  if (title) {
    normalizedFields.title = title;
  }

  if (description) {
    normalizedFields.description = description;
  }

  if (dueDate) {
    normalizedFields.due_date = dueDate;
  }

  if (status) {
    normalizedFields.status = status;
  }

  if (priority) {
    normalizedFields.priority = priority;
  }

  return normalizedFields;
}

function defaultListRequest(): AiTaskListRequest {
  return {
    status: null,
    due_date: null,
    priority: null,
    search_text: null,
    open_only: false,
    include_pending: false,
    limit: 10,
  };
}

function limitOrDefault(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }

  return Math.min(Math.max(value, 1), 20);
}

function taskNumberOrNull(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }

  return value >= 1 && value <= 10 ? value : null;
}

function escapeLikePattern(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

async function analyzeTaskWithAi(input: {
  text: string;
  userId: number;
  existingDraft: TaskDraft | null;
  today: string;
}): Promise<AiAnalysis> {
  const parsed = await callOllamaJson([
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
  ]);

  return normalizeAnalysis(parsed, input);
}

async function callOllamaJson(messages: Array<{ role: "system" | "user"; content: string }>) {
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
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama request failed: ${response.status} ${body}`);
  }

  const ollamaResult = await response.json();
  return parseJsonObject(ollamaResult?.message?.content);
}

function buildSystemPrompt(today: string) {
  const dateReference = buildDateReference(today);

  return `
You are a project-management intake assistant for a small company.
Today is ${today}.
${dateReference}

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
- Do not calculate weekdays yourself. Use the provided date reference for phrases like 今個星期五, 這個星期五, 下星期一, 下週三.
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

function buildDateReference(today: string) {
  const currentWeek = buildWeekReference(today, 0);
  const nextWeek = buildWeekReference(today, 1);

  return [
    "Date reference. Use these dates exactly:",
    `- Current week: ${currentWeek}`,
    `- Next week: ${nextWeek}`,
  ].join("\n");
}

function buildWeekReference(today: string, weekOffset: number) {
  const labels = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];

  return labels
    .map((label, index) => `${label}=${getDateForWeekday(today, weekOffset, index)}`)
    .join(", ");
}

function applyRelativeWeekdayOverrideToCommand(command: AiCommand, text: string, today: string) {
  const dueDate = inferRelativeWeekdayDate(text, today);

  if (!dueDate) {
    return;
  }

  if (command.action === "list" && command.list) {
    command.list.due_date = dueDate;
  }

  if (command.action === "update" && command.update) {
    command.update.fields.due_date = dueDate;
  }

  if (command.action === "create" && command.create) {
    applyDueDateToAnalysis(command.create, dueDate);
  }
}

function applyRelativeWeekdayOverrideToAnalysis(analysis: AiAnalysis, text: string, today: string) {
  const dueDate = inferRelativeWeekdayDate(text, today);

  if (dueDate) {
    applyDueDateToAnalysis(analysis, dueDate);
  }
}

function applyDueDateToAnalysis(analysis: AiAnalysis, dueDate: string) {
  analysis.task.due_date = dueDate;
  analysis.missing_fields = analysis.missing_fields.filter((field) => field !== "due_date");
  analysis.ready_to_save = analysis.missing_fields.length === 0 && Boolean(analysis.task.title);
}

function inferRelativeWeekdayDate(text: string, today: string) {
  const currentWeekMatch = text.match(
    /(?:今個星期|今星期|這個星期|呢個星期|本星期|今週|本週|今周|本周)\s*(?:星期|週|周|禮拜)?\s*([一二三四五六日天1234567])/,
  );

  if (currentWeekMatch) {
    return getDateForWeekday(today, 0, weekdayTextToIndex(currentWeekMatch[1]));
  }

  const nextWeekMatch = text.match(
    /(?:下個星期|下星期|下週|下周)\s*(?:星期|週|周|禮拜)?\s*([一二三四五六日天1234567])/,
  );

  if (nextWeekMatch) {
    return getDateForWeekday(today, 1, weekdayTextToIndex(nextWeekMatch[1]));
  }

  return null;
}

function weekdayTextToIndex(value: string) {
  const weekdayMap: Record<string, number> = {
    "1": 0,
    一: 0,
    "2": 1,
    二: 1,
    "3": 2,
    三: 2,
    "4": 3,
    四: 3,
    "5": 4,
    五: 4,
    "6": 5,
    六: 5,
    "7": 6,
    日: 6,
    天: 6,
  };

  return weekdayMap[value] ?? 0;
}

function getDateForWeekday(today: string, weekOffset: number, weekdayIndex: number) {
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  const todayWeekdayIndex = (todayDate.getUTCDay() + 6) % 7;
  const mondayDate = addDays(todayDate, -todayWeekdayIndex);
  const targetDate = addDays(mondayDate, weekOffset * 7 + weekdayIndex);

  return targetDate.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
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

function formatTaskLine(task: TaskRow, number: number) {
  const dueDate = task.due_date ? `，期限：${task.due_date}` : "";
  const priority = task.priority !== "medium" ? `，${formatPriority(task.priority)}` : "";
  const status = formatStatus(task.status);

  return `${number}. ${task.title}（${status}${dueDate}${priority}）`;
}

function formatStatus(status: TaskStatus) {
  if (status === "done") {
    return "已完成";
  }

  if (status === "in_progress") {
    return "進行中";
  }

  return "待辦";
}

function formatPriority(priority: Priority) {
  if (priority === "high") {
    return "高優先";
  }

  if (priority === "low") {
    return "低優先";
  }

  return "中優先";
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

function priorityOrNull(value: unknown): Priority | null {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function statusOrNull(value: unknown): TaskStatus | null {
  return value === "todo" || value === "in_progress" || value === "done" ? value : null;
}
