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
const ALLOWED_ORDER_BY = new Set([
  "folder,name",
  "name",
  "modifiedTime desc",
  "modifiedTime",
  "createdTime desc",
  "createdTime",
]);

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

function clampInt(value, defaultValue, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.min(Math.max(Math.floor(n), min), max);
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

function scoreNameMatch(name, query) {
  const normalizedName = normalizeSearchTerm(name);
  const normalizedQuery = normalizeSearchTerm(query);

  if (!normalizedQuery) return 0;
  if (normalizedName === normalizedQuery) return 100;
  if (normalizedName.startsWith(normalizedQuery)) return 80;
  if (normalizedName.includes(normalizedQuery)) return 60;

  const tokens = normalizedQuery.match(/[a-z]+|\d+/g) || [];
  const tokenHits = tokens.filter((t) => normalizedName.includes(t)).length;
  if (tokenHits > 0) return 20 + tokenHits * 5;

  return 0;
}

function badRequest(res, message) {
  return res.status(400).json({
    error: "BAD_REQUEST",
    message,
    statusCode: 400,
  });
}

function mapGoogleError(error, fallbackCode, fallbackMessage) {
  const status = error?.response?.status || error?.code || 500;

  if (status === 400) {
    return {
      statusCode: 400,
      error: "BAD_REQUEST",
      message: error?.message || fallbackMessage,
    };
  }

  if (status === 401) {
    return {
      statusCode: 401,
      error: "UNAUTHORIZED",
      message: "Autenticação Google inválida ou expirada",
    };
  }

  if (status === 403) {
    return {
      statusCode: 403,
      error: "FORBIDDEN",
      message: "Sem permissão para aceder ao recurso no Google Drive",
    };
  }

  if (status === 404) {
    return {
      statusCode: 404,
      error: "NOT_FOUND",
      message: "Recurso não encontrado no Google Drive",
    };
  }

  return {
    statusCode: 500,
    error: fallbackCode,
    message: fallbackMessage,
  };
}

function handleError(res, error, fallbackCode, fallbackMessage) {
  console.error(error);
  const mapped = mapGoogleError(error, fallbackCode, fallbackMessage);
  return res.status(mapped.statusCode).json(mapped);
}

async function listAllChildren(drive, parentId) {
  const results = [];
  let pageToken;

  do {
    const response = await drive.files.list({
      q: `'${parentId}' in parents and trashed=false`,
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
      fields:
        "nextPageToken, files(id,name,mimeType,parents,driveId,webViewLink,webContentLink,createdTime,modifiedTime,size,trashed)",
      orderBy: "folder,name",
    });

    results.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return results;
}

async function getFileMeta(drive, fileId) {
  const response = await drive.files.get({
    fileId,
    supportsAllDrives: true,
    fields:
      "id,name,mimeType,parents,driveId,webViewLink,webContentLink,createdTime,modifiedTime,size,trashed",
  });

  return response.data;
}

async function getRootMeta(drive) {
  await drive.files.list({
    q: "'root' in parents and trashed=false",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "user",
    fields: "files(id)",
  });

  return {
    id: "root",
    name: "My Drive",
    mimeType: FOLDER_MIME,
    isFolder: true,
    parents: [],
    webViewLink: null,
    webContentLink: null,
    createdTime: null,
    modifiedTime: null,
    size: null,
    trashed: false,
    driveId: null,
  };
}

async function listFolderPage(drive, folderId, pageSize = 100, pageToken = undefined, orderBy = "folder,name") {
  const safePageSize = clampInt(pageSize, 100, 1, 1000);
  const safeOrderBy = ALLOWED_ORDER_BY.has(orderBy) ? orderBy : "folder,name";

  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    pageSize: safePageSize,
    pageToken,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
    fields:
      "nextPageToken, files(id,name,mimeType,parents,driveId,webViewLink,webContentLink,createdTime,modifiedTime,size,trashed)",
    orderBy: safeOrderBy,
  });

  return {
    nextPageToken: response.data.nextPageToken || null,
    files: response.data.files || [],
  };
}

async function searchWithinParentLocally(drive, parentId, query, mimeType, foldersOnly, pageSize) {
  const children = await listAllChildren(drive, parentId);

  let items = children.filter((item) => {
    if (foldersOnly && item.mimeType !== FOLDER_MIME) return false;
    if (!foldersOnly && mimeType && item.mimeType !== mimeType) return false;

    const score = scoreNameMatch(item.name, query);
    return score > 0;
  });

  items.sort((a, b) => {
    const scoreDiff = scoreNameMatch(b.name, query) - scoreNameMatch(a.name, query);
    if (scoreDiff !== 0) return scoreDiff;
    return a.name.localeCompare(b.name, "pt");
  });

  return items.slice(0, clampInt(pageSize, 50, 1, 1000));
}

async function searchGloballyViaApi(drive, { query, parentId, mimeType, foldersOnly, pageSize }) {
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

  const response = await drive.files.list({
    q,
    pageSize: clampInt(pageSize, 50, 1, 1000),
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
    fields:
      "files(id,name,mimeType,parents,driveId,webViewLink,webContentLink,createdTime,modifiedTime,size,trashed)",
    orderBy: "folder,name",
  });

  const items = response.data.files || [];

  items.sort((a, b) => {
    const scoreDiff = scoreNameMatch(b.name, query) - scoreNameMatch(a.name, query);
    if (scoreDiff !== 0) return scoreDiff;
    return a.name.localeCompare(b.name, "pt");
  });

  return items;
}

async function searchDriveItems(drive, { query, parentId, mimeType, foldersOnly = false, pageSize = 50 }) {
  if (parentId) {
    return searchWithinParentLocally(drive, parentId, query, mimeType, foldersOnly, pageSize);
  }

  return searchGloballyViaApi(drive, { query, parentId, mimeType, foldersOnly, pageSize });
}

async function buildTree(drive, rootId, maxDepth = 5, depth = 0, visited = new Set()) {
  if (visited.has(rootId)) {
    return null;
  }

  visited.add(rootId);

  const meta = rootId === "root"
    ? await getRootMeta(drive)
    : normalizeDriveItem(await getFileMeta(drive, rootId));

  if (depth >= maxDepth || meta.mimeType !== FOLDER_MIME) {
    return { ...meta, children: [] };
  }

  const children = await listAllChildren(drive, rootId);
  const mapped = [];

  for (const child of children) {
    if (child.mimeType === FOLDER_MIME) {
      const subtree = await buildTree(drive, child.id, maxDepth, depth + 1, visited);
      if (subtree) mapped.push(subtree);
    } else {
      mapped.push({ ...normalizeDriveItem(child), children: [] });
    }
  }

  return { ...meta, children: mapped };
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

    if (currentId === "root") {
      segments.unshift({
        id: "root",
        name: "My Drive",
        mimeType: FOLDER_MIME,
        isFolder: true,
        parents: [],
        webViewLink: null,
        webContentLink: null,
        createdTime: null,
        modifiedTime: null,
        size: null,
        trashed: false,
        driveId: null,
      });
      break;
    }

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
    const root = await getRootMeta(drive);
    return res.json(root);
  } catch (error) {
    return handleError(res, error, "ROOT_ERROR", "Erro ao obter a raiz do Drive");
  }
});

app.get("/reb/drive/file", async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = String(req.query.fileId || "").trim();

    if (!fileId) {
      return badRequest(res, "fileId é obrigatório");
    }

    if (fileId === "root") {
      const root = await getRootMeta(drive);
      return res.json(root);
    }

    const meta = await getFileMeta(drive, fileId);
    return res.json(normalizeDriveItem(meta));
  } catch (error) {
    return handleError(res, error, "FILE_META_ERROR", "Erro ao obter metadados do ficheiro");
  }
});

app.get("/reb/drive/list", async (req, res) => {
  try {
    const drive = getDrive();
    const folderId = String(req.query.folderId || "").trim();
    const pageSize = clampInt(req.query.pageSize || 100, 100, 1, 1000);
    const pageToken = req.query.pageToken ? String(req.query.pageToken) : undefined;
    const orderBy = String(req.query.orderBy || "folder,name");

    if (!folderId) {
      return badRequest(res, "folderId é obrigatório");
    }

    const folderMeta = folderId === "root"
      ? await getRootMeta(drive)
      : normalizeDriveItem(await getFileMeta(drive, folderId));

    if (!folderMeta.isFolder) {
      return badRequest(res, "folderId não corresponde a uma pasta");
    }

    const page = await listFolderPage(drive, folderId, pageSize, pageToken, orderBy);

    return res.json({
      folderId,
      folderName: folderMeta.name,
      items: page.files.map(normalizeDriveItem),
      nextPageToken: page.nextPageToken,
    });
  } catch (error) {
    return handleError(res, error, "LIST_ERROR", "Erro ao listar conteúdo da pasta");
  }
});

app.get("/reb/drive/search", async (req, res) => {
  try {
    const drive = getDrive();
    const query = String(req.query.query || "").trim();
    const parentId = req.query.parentId ? String(req.query.parentId).trim() : null;
    const mimeType = req.query.mimeType ? String(req.query.mimeType).trim() : null;
    const foldersOnly = String(req.query.foldersOnly || "false").toLowerCase() === "true";
    const pageSize = clampInt(req.query.pageSize || 50, 50, 1, 1000);

    if (!query) {
      return badRequest(res, "query é obrigatório");
    }

    if (parentId && parentId !== "root") {
      const parentMeta = normalizeDriveItem(await getFileMeta(drive, parentId));
      if (!parentMeta.isFolder) {
        return badRequest(res, "parentId não corresponde a uma pasta");
      }
    }

    const items = await searchDriveItems(drive, {
      query,
      parentId,
      mimeType,
      foldersOnly,
      pageSize,
    });

    return res.json({
      query,
      parentId,
      items: items.map(normalizeDriveItem),
    });
  } catch (error) {
    return handleError(res, error, "SEARCH_ERROR", "Erro na pesquisa do Drive");
  }
});

app.get("/reb/drive/parents", async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = String(req.query.fileId || "").trim();

    if (!fileId) {
      return badRequest(res, "fileId é obrigatório");
    }

    if (fileId === "root") {
      return res.json({
        fileId,
        parents: [],
      });
    }

    const meta = await getFileMeta(drive, fileId);
    const parentIds = meta.parents || [];
    const parents = [];

    for (const parentId of parentIds) {
      if (parentId === "root") {
        parents.push(await getRootMeta(drive));
      } else {
        const parentMeta = await getFileMeta(drive, parentId);
        parents.push(normalizeDriveItem(parentMeta));
      }
    }

    return res.json({
      fileId,
      parents,
    });
  } catch (error) {
    return handleError(res, error, "PARENTS_ERROR", "Erro ao obter parents do item");
  }
});

app.get("/reb/drive/path", async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = String(req.query.fileId || "").trim();

    if (!fileId) {
      return badRequest(res, "fileId é obrigatório");
    }

    const segments = await getPathSegments(drive, fileId);
    const path = segments.map((segment) => segment.name).join(" > ");

    return res.json({
      fileId,
      path,
      segments,
    });
  } catch (error) {
    return handleError(res, error, "PATH_ERROR", "Erro ao reconstruir caminho do item");
  }
});

app.get("/reb/drive/tree", async (req, res) => {
  try {
    const drive = getDrive();
    const rootId = String(req.query.rootId || "").trim();
    const maxDepth = clampInt(req.query.maxDepth || 5, 5, 1, 20);

    if (!rootId) {
      return badRequest(res, "rootId é obrigatório");
    }

    const tree = await buildTree(drive, rootId, maxDepth);
    if (!tree) {
      return res.json({
        rootId,
        rootName: null,
        maxDepth,
        nodes: [],
      });
    }

    const nodes = flattenTree(tree);

    return res.json({
      rootId,
      rootName: tree.name,
      maxDepth,
      nodes,
    });
  } catch (error) {
    return handleError(res, error, "TREE_ERROR", "Erro ao gerar árvore do Drive");
  }
});

app.get("/reb/drive/index", async (req, res) => {
  try {
    const drive = getDrive();
    const rootId = String(req.query.rootId || "").trim();
    const maxDepth = clampInt(req.query.maxDepth || 5, 5, 1, 20);

    if (!rootId) {
      return badRequest(res, "rootId é obrigatório");
    }

    const tree = await buildTree(drive, rootId, maxDepth);
    if (!tree) {
      return res.json({
        scannedAt: new Date().toISOString(),
        rootId,
        maxDepth,
        totalItems: 0,
        totalFolders: 0,
        totalFiles: 0,
        items: [],
      });
    }

    const items = flattenTree(tree);

    return res.json({
      scannedAt: new Date().toISOString(),
      rootId,
      maxDepth,
      totalItems: items.length,
      totalFolders: items.filter((item) => item.isFolder).length,
      totalFiles: items.filter((item) => !item.isFolder).length,
      items,
    });
  } catch (error) {
    return handleError(res, error, "INDEX_ERROR", "Erro ao gerar índice do Drive");
  }
});

app.get("/reb/drive/download", async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = String(req.query.fileId || "").trim();

    if (!fileId) {
      return badRequest(res, "fileId é obrigatório");
    }

    if (fileId === "root") {
      return badRequest(res, "Não é possível fazer download da raiz do Drive");
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
    return handleError(res, error, "DOWNLOAD_ERROR", "Erro no download do ficheiro");
  }
});

app.get("/reb/drive/export", async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = String(req.query.fileId || "").trim();
    const mimeType = String(req.query.mimeType || "").trim();

    if (!fileId || !mimeType) {
      return badRequest(res, "fileId e mimeType são obrigatórios");
    }

    if (fileId === "root") {
      return badRequest(res, "Não é possível exportar a raiz do Drive");
    }

    const response = await drive.files.export(
      { fileId, mimeType },
      { responseType: "stream" },
    );

    res.setHeader("Content-Type", mimeType);
    response.data.pipe(res);
  } catch (error) {
    return handleError(res, error, "EXPORT_ERROR", "Erro a exportar ficheiro Google Workspace");
  }
});

app.listen(PORT, () => {
  console.log(`REB Drive backend a correr na porta ${PORT}`);
});
