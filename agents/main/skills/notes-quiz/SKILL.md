---
name: notesquiz
description: Generate quiz questions from uploaded photos of handwritten or typed notes. Use when a user shares an image of their notes and wants to be quizzed, tested, or drilled on the content. Supports any subject. Triggers on commands like /notesquiz, "quiz me on my notes", or when a user uploads a note photo and asks for questions.
---

# NotesQuiz

Turn photos of notes into an interactive quiz session.

## Workflow

1. **Receive image(s)** — user uploads one or more photos of their notes
2. **Extract content** — use the `image` tool to read and understand the notes
3. **Generate questions** — create a mix of question types based on the content
4. **Quiz interactively** — ask one question at a time, wait for the answer, give feedback, then continue

## Question Generation

Generate 5–10 questions per image depending on content density. Mix types:

- **Multiple choice** (A/B/C/D) — good for definitions, dates, names
- **Fill in the blank** — good for formulas, vocabulary, key terms
- **Short answer** — good for explanations, processes, concepts
- **True/False** — good for quick checks on facts

Calibrate difficulty to the apparent level of the notes (high school, college, etc.).

## Interaction Style

- Ask **one question at a time**
- After each answer: confirm correct / gently correct wrong answers with a brief explanation
- Keep a running score (e.g. "3/5 so far ✅")
- At the end, give a summary and highlight anything worth reviewing

## Tips

- If handwriting is hard to read, do your best and flag uncertain content
- If notes cover multiple topics, group questions by topic
- If the user says "harder" or "easier", adjust immediately
- If the user uploads multiple images, treat them as one study set
