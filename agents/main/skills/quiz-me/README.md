# Quiz Me

Adaptive quiz skill that generates free-response questions on any topic, grades answers with nuance, and tracks performance to surface weak areas.

## Usage

Ask your bot to quiz you:
- "Quiz me on the French Revolution"
- "Give me a hard quiz on organic chemistry"
- "/quiz_me"

## How It Works

1. You pick a topic, difficulty, and number of questions
2. The bot asks one question at a time and waits for your answer
3. After 2 correct in a row, difficulty increases; after 2 wrong, it drops and gives a structured explanation
4. Wrong answers always get a hint before the answer is revealed (non-negotiable pedagogical rule)
5. At the end: final score, weak spots, and a mini study plan

## Dependencies

None. Pure prompt-instruction skill.

## License

MIT
