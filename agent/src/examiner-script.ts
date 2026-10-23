/**
 * Fixed examiner lines. The LiveKit worker speaks these; the web app does not.
 * A copy lives at agent/src/examiner-script.ts because the worker cannot import
 * this package. tests/language.test.ts checks the two files stay identical.
 * UI chrome stays English. Only the spoken script follows the document.
 */

export interface ExaminerScript {
  intro(total: number): string;
  welcomeBack: string;
  questionLabel(index: number): string;
  acks: readonly string[];
  repeatPrefix: string;
  saveFailed: string;
  closing: string;
  repeat: RegExp;
}

const EN: ExaminerScript = {
  intro: (total) =>
    `Hi, I'm your examiner. I'll ask you ${total} questions about your document. Answer in your own words, take your time, and pause when you've finished. You can ask me to repeat a question.`,
  welcomeBack: "Welcome back. Let's pick up where we left off.",
  questionLabel: (index) => `Question ${index}.`,
  acks: ["Thanks.", "Got it.", "Okay.", "Understood.", "Thank you."],
  repeatPrefix: "Of course. ",
  saveFailed: "Sorry, I couldn't save that answer. Could you say it again?",
  closing: "That's every question. Thank you. Your answers are being graded now.",
  repeat: /\b(repeat|say (that|it) again|didn'?t (catch|hear)|pardon|come again)\b/i,
};

const ES: ExaminerScript = {
  intro: (total) =>
    `Hola, soy tu examinador. Te haré ${total} preguntas sobre tu documento. Responde con tus propias palabras, tómate tu tiempo y haz una pausa cuando termines. Puedes pedirme que repita una pregunta.`,
  welcomeBack: "Bienvenido de nuevo. Seguimos donde lo dejamos.",
  questionLabel: (index) => `Pregunta ${index}.`,
  acks: ["Gracias.", "Entendido.", "De acuerdo.", "Comprendido.", "Muchas gracias."],
  repeatPrefix: "Por supuesto. ",
  saveFailed: "Perdón, no pude guardar esa respuesta. ¿Puedes decirla otra vez?",
  closing: "Esas son todas las preguntas. Gracias. Tus respuestas se están calificando ahora.",
  // "como" and "otra vez" alone are too common in a real answer. Keep this short.
  repeat:
    /\b(repite|rep[ií]tela|puedes repetir|puede repetir|no (?:te )?(?:escuch[eé]|o[ií]|entend[ií]))\b/i,
};

const PT: ExaminerScript = {
  intro: (total) =>
    `Olá, sou o seu examinador. Vou fazer-lhe ${total} perguntas sobre o seu documento. Responda com as suas próprias palavras, sem pressa, e faça uma pausa quando terminar. Pode pedir-me para repetir uma pergunta.`,
  welcomeBack: "Bem-vindo de volta. Continuamos de onde parámos.",
  questionLabel: (index) => `Pergunta ${index}.`,
  acks: ["Obrigado.", "Entendido.", "Certo.", "Compreendido.", "Muito obrigado."],
  repeatPrefix: "Claro. ",
  saveFailed: "Desculpe, não consegui guardar essa resposta. Pode dizê-la outra vez?",
  closing: "São todas as perguntas. Obrigado. As suas respostas estão a ser avaliadas agora.",
  repeat: /\b(repete|repita|pode repetir|podes repetir|n[aã]o (?:te )?(?:ouvi|entendi))\b/i,
};

export function examinerScript(language: string | null | undefined): ExaminerScript {
  const code = (language ?? "").trim().toLowerCase().replace(/_/g, "-").split("-")[0] ?? "";
  if (code === "es") return ES;
  if (code === "pt") return PT;
  return EN;
}
