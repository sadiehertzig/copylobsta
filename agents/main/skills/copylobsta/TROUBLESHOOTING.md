# CopyLobsta Troubleshooting Guide

## CloudFormation Stack Issues

### Stack stuck in CREATE_IN_PROGRESS
Wait up to 10 minutes. If it's been longer:
1. Open AWS Console → CloudFormation → your stack
2. Check the Events tab for the specific resource that's stuck
3. Common cause: EC2 capacity issues in us-east-1. Try deleting and relaunching.

### Stack in ROLLBACK_COMPLETE
The creation failed and AWS cleaned up. Check Events tab for the root cause.
Common causes:
- **LimitExceeded**: Your AWS account has hit the EC2 instance limit. Go to Service Quotas → EC2 → Running On-Demand Standard instances → Request increase.
- **Access denied**: You're using a restricted IAM user. Use the root account or an admin user.
- **Stack name already exists**: Delete the old stack first (select stack → Delete), then retry.

### How to delete a stack
1. AWS Console → CloudFormation
2. Select the stack → Delete
3. Wait for DELETE_COMPLETE (takes a few minutes)
4. This removes the EC2 instance, Elastic IP, and all associated resources
5. You will stop being charged once deletion completes

## Instance Connection Issues

### No SSM ping after launching
The setup API on your instance may still be starting.
1. Wait 5 minutes after stack shows CREATE_COMPLETE
2. Check EC2 Console → Instances → your instance → Status checks should show 2/2
3. If Instance Status is "impaired": Stop and Start the instance (not reboot)
4. Verify the instance has an IAM role with SSM permissions (check instance details)

### "Could not reach your server" during key validation
1. The setup API runs on port 8080 — check that Security Group allows inbound 8080
2. Try refreshing the Mini App
3. If the instance was restarted, the setup API may need to be restarted:
   - In AWS Console → Systems Manager → Run Command
   - Run: `cd /home/ubuntu/copylobsta && node setup-api/dist/index.js`

## API Key Issues

### Anthropic: "Key doesn't have permission"
Your Anthropic account needs billing set up:
1. Go to console.anthropic.com → Settings → Billing
2. Add a payment method
3. Then retry key validation

### OpenAI: "Rate limit" error on a new key
Your OpenAI account needs credits:
1. Go to platform.openai.com → Settings → Billing
2. Add credit balance ($10 minimum recommended)
3. Wait a minute, then retry

### Telegram: "Invalid bot token"
1. Open @BotFather in Telegram
2. Send `/mybots` → select your bot → API Token
3. Copy the full token (format: `123456789:ABCdef...`)
4. Make sure there are no extra spaces

### Key accidentally pasted in Telegram chat
CopyLobsta auto-deletes messages containing API keys. If it didn't catch one:
1. Delete the message manually
2. Rotate the key immediately at the provider's dashboard
3. Re-enter the new key in the Mini App

## Deployment Issues

### Deploy fails at "Installing dependencies"
Usually a disk space or memory issue:
- Check if the instance has enough disk: should have 64GB
- If npm install is killed (OOM): the t3.medium (4GB RAM) should be sufficient, but if you changed instance type, ensure at least 2GB RAM

### Deploy fails at "Health check"
The bot started but isn't responding:
1. Check that all required API keys are in Secrets Manager (AWS Console → Secrets Manager → filter by "openclaw/")
2. Check the bot logs: Systems Manager → Run Command → `journalctl -u openclaw-gateway -n 50`
3. Common issue: Telegram bot token is correct but the bot was never `/start`ed by BotFather

### Bot doesn't respond after "Your bot is live!"
1. Open a DM with your bot in Telegram
2. Send `/start`
3. If no response, check if the process is running: `pm2 list` via SSM Run Command
4. Check logs: `pm2 logs openclaw --lines 50`

## Session Issues

### "Resume or cancel?" when restarting
You have an existing session in progress. Choose:
- **Resume**: Continue where you left off
- **Cancel**: Start fresh (remember to delete your CloudFormation stack if one was created)

### Session stuck or unresponsive
Refresh the Mini App. Your progress is saved — you'll resume at the last completed step.

## Cost Management

### AWS charges higher than expected
1. Check EC2 → Instances — make sure only ONE instance is running
2. Check for leftover Elastic IPs (charged if not attached to a running instance)
3. Verify no extra EBS volumes exist
4. Set up a billing alarm: Billing → Budgets → Create budget → $50/month

### API costs higher than expected
Each provider has spend controls:
- **Anthropic**: console.anthropic.com → Settings → Limits → Monthly spend limit
- **OpenAI**: platform.openai.com → Settings → Billing → Set budget
- **Gemini**: Free tier has built-in rate limits. Paid tier: console.cloud.google.com → Billing → Budgets
