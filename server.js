import "dotenv/config";
import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI || !GOOGLE_REFRESH_TOKEN) {
  console.error("Faltam variáveis de ambiente do Google OAuth.");
}

function getAuth() {
  const auth = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
  );

  auth.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN,
  });

  return auth;
}

function getDrive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

async function listAllChildren(drive, parentId) {
  const results = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and trashed=false`,
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
      fields: "nextPageToken, files(id,name,mimeType,parents,driveId,webViewLink,createdTime,modifiedTime,size)",
      orderBy: "folder,name",
    });

    results.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return results;
}

async function getFileMeta(drive, fileId) {
  const res = await drive.files.get({
    fileId,
    supportsAllDrives: true,
    fields: "id,name,mimeType,parents,driveId,webViewLink,createdTime,modifiedTime,size",
  });

  return res.data;
}

async function buildTree(drive, rootId, maxDepth = 5, depth = 0) {
  const meta = await getFileMeta(drive, rootId);

  if (depth >= maxDepth || meta.mimeType !== "application/vnd.google-apps.folder") {
    return { ...meta, children: [] };
  }

  const children = await listAllChildren(drive, rootId);
  const mapped = [];

  for (const child of children) {
    if (child.mimeType === "application/vnd.google-apps.folder") {
      mapped.push(await buildTree(drive, child.id, maxDepth, depth + 1));
    } else {
      mapped.push({ ...child, children: [] });
    }
  }

  return { ...meta, children: mapped };
}

async function flattenTree(node, currentPath = "") {
  const path = currentPath ? `${currentPath} > ${node.name}` : node.name;
  let rows = [
    {
      id: node.id,
      name: node.name,
      mimeType: node.mimeType,
      path,
      webViewLink: node.webViewLink || null,
      modifiedTime: node.modifiedTime || null,
      size: node.size || null,
    },
  ];

  for (const child of node.children || []) {
    rows = rows.concat(await flattenTree(child, path));
  }

  return rows;
}

app.get("/health", async (_req, res) => {
  res.json({ ok: true, service: "reb-drive-backend" });
});

app.get("/reb/drive/tree", async (req, res) => {
  try {
    const drive = getDrive();
    const rootId = String(req.query.rootId || "").trim();
    const maxDepth = Number(req.query.maxDepth || 5);

    if (!rootId) {
      return res.status(400).json({ error: "rootId é obrigatório" });
    }

    const tree = await buildTree(drive, rootId, maxDepth);
    res.json({
      scannedAt: new Date().toISOString(),
      rootId,
      maxDepth,
      tree,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao gerar árvore do Drive" });
  }
});

app.get("/reb/drive/index", async (req, res) => {
  try {
    const drive = getDrive();
    const rootId = String(req.query.rootId || "").trim();
    const maxDepth = Number(req.query.maxDepth || 5);

    if (!rootId) {
      return res.status(400).json({ error: "rootId é obrigatório" });
    }

    const tree = await buildTree(drive, rootId, maxDepth);
    const items = await flattenTree(tree);

    res.json({
      scannedAt: new Date().toISOString(),
      rootId,
      maxDepth,
      totalItems: items.length,
      totalFolders: items.filter(i => i.mimeType === "application/vnd.google-apps.folder").length,
      totalFiles: items.filter(i => i.mimeType !== "application/vnd.google-apps.folder").length,
      items,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao gerar índice do Drive" });
  }
});

app.get("/reb/drive/file", async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = String(req.query.fileId || "").trim();

    if (!fileId) {
      return res.status(400).json({ error: "fileId é obrigatório" });
    }

    const meta = await getFileMeta(drive, fileId);
    res.json(meta);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao obter metadados do ficheiro" });
  }
});

app.get("/reb/drive/download", async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = String(req.query.fileId || "").trim();

    if (!fileId) {
      return res.status(400).json({ error: "fileId é obrigatório" });
    }

    const meta = await getFileMeta(drive, fileId);

    if (meta.mimeType?.startsWith("application/vnd.google-apps")) {
      return res.status(400).json({
        error: "Este ficheiro é Google Workspace. Usa /reb/drive/export para Docs/Sheets/Slides.",
        mimeType: meta.mimeType,
      });
    }

    const response = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "stream" },
    );

    res.setHeader("Content-Disposition", `inline; filename="${meta.name}"`);
    if (meta.mimeType) res.setHeader("Content-Type", meta.mimeType);
    response.data.pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro no download do ficheiro" });
  }
});

app.get("/reb/drive/export", async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = String(req.query.fileId || "").trim();
    const mimeType = String(req.query.mimeType || "").trim();

    if (!fileId || !mimeType) {
      return res.status(400).json({ error: "fileId e mimeType são obrigatórios" });
    }

    const response = await drive.files.export(
      { fileId, mimeType },
      { responseType: "stream" },
    );

    res.setHeader("Content-Type", mimeType);
    response.data.pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro a exportar ficheiro Google Workspace" });
  }
});

app.listen(PORT, () => {
  console.log(`REB Drive backend a correr na porta ${PORT}`);
});
