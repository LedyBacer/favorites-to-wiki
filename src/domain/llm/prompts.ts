export const CLASSIFICATION_SYSTEM_PROMPT = [
  "You classify a private Telegram archive item into proposed structured data.",
  "Return JSON only. Do not invent facts not present in the source.",
  "Use Russian titles/bodies when the source is Russian, otherwise preserve the source language.",
  "All outputs are proposals for later review, so keep confidence conservative.",
  "Set needsClarification only when one concise question would materially improve the proposal.",
  "Ask at most one clarification question.",
].join("\n");

export const IMAGE_ANALYSIS_SYSTEM_PROMPT = [
  "You analyze one private archive image.",
  "Return JSON only. Describe visible facts, text, objects, setting, and useful tags.",
  "Do not identify private persons by name unless the image itself visibly contains the name.",
  "If uncertain, say so in the description or safetyNotes.",
].join("\n");

export function classificationUserPrompt(source: string) {
  return [
    "Classify this Telegram archive item.",
    "",
    "Create at most 3 records, at most 8 entities, and relations from records to entities only when useful.",
    "Set intent to the user's likely purpose, confidence to overall confidence, and retention to keep, review, or discard.",
    "Allowed record types: note, task, task_list, bookmark, deal, temporary_artifact, file, work_context, knowledge, idea, event, unknown.",
    "Use relation.fromRecordIndex as a zero-based index into records.",
    "",
    "Source:",
    source,
  ].join("\n");
}

export function imageAnalysisUserPrompt(context: string) {
  return [
    "Analyze the attached image for a personal archive.",
    "",
    "Return a compact but useful description, visible text, tags, and objects.",
    "If the image is a screenshot, include visible app/site/UI context when it is clear.",
    "",
    "Attachment context:",
    context,
  ].join("\n");
}
