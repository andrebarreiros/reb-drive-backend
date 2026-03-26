import { google } from "googleapis";
import readline from "readline";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "COLOCA_AQUI_O_CLIENT_ID";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "COLOCA_AQUI_O_CLIENT_SECRET";
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback";

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const scopes = [
  "https://www.googleapis.com/auth/drive"
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: scopes,
});

console.log("Abre este URL no browser:");
console.log(authUrl);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("Cole aqui o code: ", async (code) => {
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    console.log("\nTOKENS:");
    console.log(JSON.stringify(tokens, null, 2));
    console.log("\nGuarda o refresh_token no teu .env");
  } catch (error) {
    console.error("Erro ao trocar code por tokens:", error);
  } finally {
    rl.close();
  }
});
