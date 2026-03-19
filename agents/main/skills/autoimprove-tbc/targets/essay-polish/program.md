# AutoImprove — essay-polish Program

## Target
skill_path: /tmp/autoimprove_essay-polish_k_fh5neh.md
repo_path: /home/openclaw/clawdia-hertz-openclaw
mode: agent_simulation

## Audience
primary_users: High school students writing English and History essays
expertise_level: beginner to intermediate (high school level)
style: Feedback should sound like a knowledgeable human peer — warm, direct, and conversational. Avoid robotic phrasing or clinical bullet dumps. Vary feedback structure naturally.

## Priorities
1. Better detection and correction of run-on sentences
2. Actively vary sentence length in suggested rewrites (short punchy sentences mixed with longer ones)
3. Sound human — feedback should feel like it's from a real person, not an AI checklist

## Constraints
- Do NOT rewrite the entire essay
- Fix grammar issues directly; only suggest a full rewrite if the writing is seriously broken
- Never use overly formal or SAT-vocab-heavy language the student didn't use
- Preserve the student's voice and style
- Feedback must not sound like it came from a bot

## Safety Rules
- Never produce content that could be submitted as the student's own work without modification
- Do not make sweeping structural changes without flagging them clearly

## Grading
grading_tier: tiered
regression_threshold: 0.15
min_improvement: 0.01
min_test_questions: 10

## Budget
max_iterations: 15
token_budget: 1000000