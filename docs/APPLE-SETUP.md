# Turning on Apple Music

Apple Music stays hidden on the host page until three secrets are set on the Worker:
`APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY`. The code is already deployed with the
rest of ClassQueue. Turning it on takes about 15 minutes once you have the account.

What you need:
- An **Apple Developer Program** membership (paid, yearly), signed in at
  <https://developer.apple.com/account>.
- The teacher who plays the music needs an **Apple Music subscription** on their own Apple
  account. That account signs in on the host page. It does not have to be the developer account.

## 1. Make a Media ID (one time)

1. Go to <https://developer.apple.com/account/resources/identifiers/list>.
2. Click the blue **+**. Pick **Media IDs** and click **Continue**.
3. Description: `ClassQueue`. Identifier: `media.com.example.roomdj` (any reverse-domain
   name you like, starting with `media.`). Leave the services ticked. Click **Continue**, then
   **Register**.

## 2. Make the MusicKit private key

1. Go to <https://developer.apple.com/account/resources/authkeys/list> and click the blue **+**.
2. Key Name: `ClassQueue MusicKit`. Tick **Media Services (MusicKit, ShazamKit, Apple Music Feed)**,
   click **Configure** next to it, pick the `ClassQueue` Media ID, and click **Save**.
3. Click **Continue**, then **Register**.
4. Click **Download**. You get **one** download only. The file lands in Downloads as
   `AuthKey_XXXXXXXXXX.p8`. The 10 letters and numbers after `AuthKey_` are the **Key ID**. The
   key's page also shows the Key ID.

## 3. Find your Team ID

Open <https://developer.apple.com/account> and scroll to **Membership details**. The **Team ID**
has 10 letters and numbers, for example `AB12CD34EF`.

## 4. Put the three secrets on the Worker

Open PowerShell in the ClassQueue folder (`C:\Users\Mo Chara\Desktop\classqueue`). Each command
asks you to sign in to Cloudflare the first time.

```powershell
npx wrangler secret put APPLE_TEAM_ID
# paste the Team ID, press Enter

npx wrangler secret put APPLE_KEY_ID
# paste the Key ID, press Enter
```

The private key has several lines, so do not paste it at the prompt. A prompt keeps only the
first line. Pipe the whole file in instead. Change `XXXXXXXXXX` to your Key ID:

```powershell
Get-Content "$HOME\Downloads\AuthKey_XXXXXXXXXX.p8" -Raw | npx wrangler secret put APPLE_PRIVATE_KEY
```

Wrangler puts each secret live as soon as you set it. You do not need to deploy.

## 5. Delete the key file

The key is now stored on Cloudflare. Do not keep a copy in Downloads:

```powershell
Remove-Item "$HOME\Downloads\AuthKey_XXXXXXXXXX.p8"
```

`Remove-Item` skips the Recycle Bin. If you ever need the key again, make a new one in step 2.
Then revoke the old one on the Keys page and put the new Key ID and file on the Worker with step 4.

## 6. Check it

1. Open `https://<the site>/api/config`. It should say `"apple":true`.
2. Open the host page, open a room, and pick **Apple Music** under "Music from".
3. Click **Connect Apple Music**. Apple's sign-in window opens. Sign in with the account that has
   the Apple Music subscription and click **Allow**.
4. Click **Start music**.

If the host page says "Apple Music did not accept this server's MusicKit key", one of the three
secrets is wrong. Do step 4 again.

## How it works

- The Worker signs a MusicKit **developer token** (an ES256 JWT) with the private key. The token
  lasts 30 hours, and its `origin` claim only works on this site. The private key never leaves the
  Worker. The Worker gives the token only to the host page of an open room, which proves it with
  its host token.
- The Apple sign-in, called the Music User Token, stays in the teacher's browser. ClassQueue's
  server never sees it.
- ClassQueue plays one song at a time from its own queue. Apple's autoplay is off. An explicit
  song never plays: ClassQueue looks for the clean version, and if Apple has none, it skips the
  song with a notice.

## Turning it off

```powershell
npx wrangler secret delete APPLE_PRIVATE_KEY
```

Apple Music disappears from the picker. If the key ever leaks, also revoke it on the Keys page.

## Testing without an Apple account (for development)

`npm run test:apple` needs a local `wrangler dev` with **throwaway** secrets. Make a fresh P-256
key just for the test. Never use a real key for testing. See the top of `test/browser/apple.mjs`.
