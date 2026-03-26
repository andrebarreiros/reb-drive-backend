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

const FOLDER_MIME = "application/vnd.google-apps.folder";

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

function normalizeDriveItem(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    isFolder: file.mimeType === FOLDER_MIME,
    parents: file.parents || [],
    webViewLink: file.webViewLink || null,
    webContentLink: file.webContentLink || null,
    createdTime: file.createdTime || null,
    modifiedTime: file.modifiedTime || null,
    size: file.size || null,
    trashed: file.trashed ?? null,
    driveId: file.driveId || null,
  };
}

function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function normalizeSearchTerm(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
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
      fields: "nextPageToken, files(id,name,mimeType,parents,driveId,webViewLink,webContentLink,createdTime,modifiedTime,size,trashed)",
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
    fields: "id,name,mimeType,parents,driveId,webViewLink,webContentLink,createdTime,modifiedTime,size,trashed",
  });

  return res.data;
}

async function listFolderPage(drive, folderId, pageSize = 100, pageToken = undefined, orderBy = "folder,name") {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    pageSize,
    pageToken,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
    fields: "nextPageToken, files(id,name,mimeType,parents,driveId,webViewLink,webContentLink,createdTime,modifiedTime,size,trashed)",
    orderBy,
  });

  return {
    nextPageToken: res.data.nextPageToken || null,
    files: res.data.files || [],
  };
}

async function searchDriveItems(drive, {
  query,
  parentId,
  mimeType,
  foldersOnly = false,
  pageSize = 50,
}) {
  const conditions = ["trashed=false"];

  if (query) {
    const safeQuery = escapeDriveQueryValue(query);
    conditions.push(`name contains '${safeQuery}'`);
  }

  if (parentId) {
    conditions.push(`'${escapeDriveQueryValue(parentId)}' in parents`);
  }

  if (foldersOnly) {
    conditions.push(`mimeType='${FOLDER_MIME}'`);
  } else if (mimeType) {
    conditions.push(`mimeType='${escapeDriveQueryValue(mimeType)}'`);
  }

  const q = conditions.join(" and ");

  const res = await drive.files.list({
    q,
    pageSize,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: parentId ? "allDrives" : "allDrives",
    fields: "files(id,name,mimeType,parents,driveId,webViewLink,webContentLink,createdTime,modifiedTime,size,trashed)",
    orderBy: "folder,name",
  });

  let items = res.data.files || [];

  if (query) {
    const normalizedQuery = normalizeSearchTerm(query);
    items = items.sort((a, b) => {
      const an = normalizeSearchTerm(a.name);
      const bn = normalizeSearchTerm(b.name);

      const aExact = an === normalizedQuery ? 1 : 0;
      const bExact = bn === normalizedQuery ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;

      const aStarts = an.startsWith(normalizedQuery) ? 1 : 0;
      const bStarts = bn.startsWith(normalizedQuery) ? 1 : 0;
      if (aStarts !== bStarts) return bStarts - aStarts;

      const aIncludes = an.includes(normalizedQuery) ? 1 : 0;
      const bIncludes = bn.includes(normalizedQuery) ? 1 : 0;
      if (aIncludes !== bIncludes) return bIncludes - aIncludes;

      return a.name.localeCompare(b.name, "pt");
    });
  }

  return items;
}

async function buildTree(drive, rootId, maxDepth = 5, depth = 0) {
  const meta = await getFileMeta(drive, rootId);

  if (depth >= maxDepth || meta.mimeType !== FOLDER_MIME) {
    return { ...normalizeDriveItem(meta), children: [] };
  }

  const children = await listAllChildren(drive, rootId);
  const mapped = [];

  for (const child of children) {
    if (child.mimeType === FOLDER_MIME) {
      mapped.push(await buildTree(drive, child.id, maxDepth, depth + 1));
    } else {
      mapped.push({ ...normalizeDriveItem(child), children: [] });
    }
  }

  return { ...normalizeDriveItem(meta), children: mapped };
}

function flattenTree(node, currentPath = "", depth = 0, parentId = null) {
  const path = currentPath ? `${currentPath} > ${node.name}` : node.name;

  let rows = [
    {
      id: node.id,
      name: node.name,
      mimeType: node.mimeType,
      isFolder: node.isFolder,
      parentId,
      depth,
      path,
      webViewLink: node.webViewLink || null,
      modifiedTime: node.modifiedTime || null,
      size: node.size || null,
    },
  ];

  for (const child of node.children || []) {
    rows = rows.concat(flattenTree(child, path, depth + 1, node.id));
  }

  return rows;
}

async function getPathSegments(drive, fileId) {
  const segments = [];
  let currentId = fileId;
  const visited = new Set();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const meta = await getFileMeta(drive, currentId);
    const normalized = normalizeDriveItem(meta);
    segments.unshift(normalized);

    const parentId = normalized.parents?.[0];
    if (!parentId) break;
    currentId = parentId;
  }

  return segments;
}

app.get("/health", async (_req, res) => {
  res.json({
    ok: true,
    service: "reb-drive-backend",
    timestamp: new Date().toISOString(),
  });
});

app.get("/reb/drive/root", async (_req, res) => {
  try {
    const drive = getDrive();
    const meta = await getFileMeta(drive, "root");

    res.json(normalizeDriveItem(meta));
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "ROOT_ERROR",
      message: "Erro ao obter a raiz do Drive",
      statusCode: 500,
    });
  }
});

app.get("/reb/drive/file", async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = String(req.query.fileId || "").trim();

    if (!fileId) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "fileId é obrigatório",
        statusCode: 400,
      });
    }

    const meta = await getFileMeta(drive, fileId);
    res.json(normalizeDriveItem(meta));
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "FILE_META_ERROR",
      message: "Erro ao obter metadados do ficheiro",
      statusCode: 500,
    });
  }
});

app.get("/reb/drive/list", async (req, res) => {
  try {
    const drive = getDrive();
    const folderId = String(req.query.folderId || "").trim();
    const pageSize = Number(req.query.pageSize || 100);
    const pageToken = req.query.pageToken ? String(req.query.pageToken) : undefined;
    const orderBy = String(req.query.orderBy || "folder,name");

    if (!folderId) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "folderId é obrigatório",
        statusCode: 400,
      });
    }

    const folderMeta = await getFileMeta(drive, folderId);
    const page = await listFolderPage(drive, folderId, pageSize, pageToken, orderBy);

    res.json({
      folderId,
      folderName: folderMeta.name,
      items: page.files.map(normalizeDriveItem),
      nextPageToken: page.nextPageToken,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "LIST_ERROR",
      message: "Erro ao listar conteúdo da pasta",
      statusCode: 500,
    });
  }
});

app.get("/reb/drive/search", async (req, res) => {
  try {
    const drive = getDrive();
    const query = String(req.query.query || "").trim();
    const parentId = req.query.parentId ? String(req.query.parentId).trim() : null;
    const mimeType = req.query.mimeType ? String(req.query.mimeType).trim() : null;
    const foldersOnly = String(req.query.foldersOnly || "false").toLowerCase() === "true";
    const pageSize = Number(req.query.pageSize || 50);

    if (!query) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "query é obrigatório",
        statusCode: 400,
      });
    }

    const items = await searchDriveItems(drive, {
      query,
      parentId,
      mimeType,
      foldersOnly,
      pageSize,
    });

    res.json({
      query,
      parentId,
      items: items.map(normalizeDriveItem),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "SEARCH_ERROR",
      message: "Erro na pesquisa do Drive",
      statusCode: 500,
    });
  }
});

app.get("/reb/drive/parents", async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = String(req.query.fileId || "").trim();

    if (!fileId) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "fileId é obrigatório",
        statusCode: 400,
      });
    }

    const meta = await getFileMeta(drive, fileId);
    const parentIds = meta.parents || [];
    const parents = [];

    for (const parentId of parentIds) {
      const parentMeta = await getFileMeta(drive, parentId);
      parents.push(normalizeDriveItem(parentMeta));
    }

    res.json({
      fileId,
      parents,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "PARENTS_ERROR",
      message: "Erro ao obter parents do item",
      statusCode: 500,
    });
  }
});

app.get("/reb/drive/path", async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = String(req.query.fileId || "").trim();

    if (!fileId) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "fileId é obrigatório",
        statusCode: 400,
      });
    }

    const segments = await getPathSegments(drive, fileId);
    const path = segments.map((s) => s.name).join(" > ");

    res.json({
      fileId,
      path,
      segments,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "PATH_ERROR",
      message: "Erro ao reconstruir caminho do item",
      statusCode: 500,
    });
  }
});

app.get("/reb/drive/tree", async (req, res) => {
  try {
    const drive = getDrive();
    const rootId = String(req.query.rootId || "").trim();
    const maxDepth = Number(req.query.maxDepth || 5);

    if (!rootId) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "rootId é obrigatório",
        statusCode: 400,
      });
    }

    const tree = await buildTree(drive, rootId, maxDepth);
    const nodes = flattenTree(tree);

    res.json({
      rootId,
      rootName: tree.name,
      maxDepth,
      nodes,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "TREE_ERROR",
      message: "Erro ao gerar árvore do Drive",
      statusCode: 500,
    });
  }
});

app.get("/reb/drive/index", async (req, res) => {
  try {
    const drive = getDrive();
    const rootId = String(req.query.rootId || "").trim();
    const maxDepth = Number(req.query.maxDepth || 5);

    if (!rootId) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "rootId é obrigatório",
        statusCode: 400,
      });
    }

    const tree = await buildTree(drive, rootId, maxDepth);
    const items = flattenTree(tree);

    res.json({
      scannedAt: new Date().toISOString(),
      rootId,
      maxDepth,
      totalItems: items.length,
      totalFolders: items.filter((i) => i.isFolder).length,
      totalFiles: items.filter((i) => !i.isFolder).length,
      items,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "INDEX_ERROR",
      message: "Erro ao gerar índice do Drive",
      statusCode: 500,
    });
  }
});

app.get("/reb/drive/download", async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = String(req.query.fileId || "").trim();

    if (!fileId) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "fileId é obrigatório",
        statusCode: 400,
      });
    }

    const meta = await getFileMeta(drive, fileId);

    if (meta.mimeType?.startsWith("application/vnd.google-apps")) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "Este ficheiro é Google Workspace. Usa /reb/drive/export para Docs/Sheets/Slides.",
        statusCode: 400,
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
    res.status(500).json({
      error: "DOWNLOAD_ERROR",
      message: "Erro no download do ficheiro",
      statusCode: 500,
    });
  }
});

app.get("/reb/drive/export", async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = String(req.query.fileId || "").trim();
    const mimeType = String(req.query.mimeType || "").trim();

    if (!fileId || !mimeType) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "fileId e mimeType são obrigatórios",
        statusCode: 400,
      });
    }

    const response = await drive.files.export(
      { fileId, mimeType },
      { responseType: "stream" },
    );

    res.setHeader("Content-Type", mimeType);
    response.data.pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "EXPORT_ERROR",
      message: "Erro a exportar ficheiro Google Workspace",
      statusCode: 500,
    });
  }
});

app.listen(PORT, () => {
  console.log(`REB Drive backend a correr na porta ${PORT}`);
});
