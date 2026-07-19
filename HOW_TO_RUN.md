# How to Run Ivy (Voice English Practice)

Follow these steps in order. You only need to do Part 1 once — after that, skip straight to Part 2 every time you want to practice.

---

## Part 1: One-time setup — get your API key

Ivy talks using Claude, an AI made by Anthropic. To use it, you need an "API key" — a secret password that lets the app talk to Claude. This is **not** included in a Claude Pro or Max subscription; it is paid for separately, but a chat session only costs a few cents.

### Step 1: Create an account

1. Open your web browser and go to: **https://platform.claude.com**
2. Click **Sign up** (or **Log in** if you already have a Claude account).
3. Follow the instructions on screen to finish creating the account.

### Step 2: Add payment

1. Once logged in, find **Settings** (usually a gear icon or your profile picture in a corner).
2. Click **Billing**.
3. Add a credit card or buy a small amount of credits — 5 dollars is plenty to start.

### Step 3: Create your API key

1. Still in Settings, click **API keys**.
2. Click **Create key**.
3. Give it any name, for example: `ivy-app`.
4. A long code starting with `sk-ant-` will appear. **Copy it immediately and paste it somewhere safe**, like a note on your computer. It is only shown once!
5. Keep this key private — anyone who has it can spend your credits.

---

## Part 2: Start the app (do this every time)

### Step 1: Double-click "Start Ivy"

1. Open the app folder: `C:\Users\Asaf\Documents\Projects\Claude projects\language_app`
2. Double-click the file called **Start Ivy** (it may show as `Start Ivy.cmd`).
3. A black window opens. **The very first time**, it will set things up and ask you to paste your API key from Part 1 — paste it (right-click pastes) and press **Enter**. You will never be asked again.
4. Your browser opens Ivy automatically. **Leave the black window open** while you practice — closing it turns Ivy off.

If the browser doesn't open by itself, open **Chrome** or **Edge** and type `localhost:4780` in the address bar.

### Step 2: Talk!

1. The first time, Ivy asks **"Who's practicing?"** — type your name and click **Start learning**. Ivy keeps separate progress for each person who uses their own name.
2. Click the green **Start conversation** button.
3. If the browser asks permission to use your **microphone**, click **Allow**.
4. Ivy will greet you out loud. When the ring around her face turns **green**, it's your turn — just speak in English.
5. The ring colors tell you what's happening:
   - **Green** = Ivy is listening, you talk now
   - **Yellow** = Ivy is thinking
   - **Blue** = Ivy is speaking
6. Click **End conversation** when you're done.

Ivy remembers which words you've already used, even after you close everything. Each session, she gently pushes you toward new common English words, and occasionally circles back to old ones you haven't said in a while, to make sure you still remember them.

---

## Turning Ivy off

1. Close the browser tab.
2. Close the black **Start Ivy** window.

---

## If something goes wrong

| Problem | What to do |
|---|---|
| Ivy says something went wrong / no reply | Your API key is probably missing or wrong. Delete the file called `.env` in the app folder, then double-click **Start Ivy** again — it will ask for the key fresh. |
| "This browser does not support speech recognition" | Use Google Chrome or Microsoft Edge instead. |
| Ivy can't hear you | Click the small lock or camera icon next to the address bar and make sure the microphone is set to **Allow**. Check your microphone is plugged in and not muted. |
| The page doesn't load at localhost:4780 | Make sure the black **Start Ivy** window is still open and shows `Voice language app running`. If not, double-click **Start Ivy** again. |
| You want to practice as a different person | Click the small **switch** link under "Words mastered" and enter the other name. |
| You want to start fresh as a new learner | With Ivy running, paste this into PowerShell (replace `yourname`): `Invoke-RestMethod -Method Post -Uri http://localhost:4780/api/reset -ContentType application/json -Body '{"name": "yourname", "clearProgress": true}'` |
