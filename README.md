# REB Drive Auth + Backend

## 1) Instalar
```bash
npm install
```

## 2) Preencher `.env`
Cria um ficheiro `.env` com base em `.env.example`.

## 3) Gerar refresh token
```bash
npm run token
```

## 4) Arrancar backend
```bash
npm start
```

## 5) Testar
- http://localhost:3000/health
- http://localhost:3000/reb/drive/file?fileId=SEU_FILE_ID
- http://localhost:3000/reb/drive/tree?rootId=SEU_ROOT_ID&maxDepth=3
- http://localhost:3000/reb/drive/index?rootId=SEU_ROOT_ID&maxDepth=3

## Notas
- Para Google Docs/Sheets/Slides, usa `/reb/drive/export`
- Para PDFs/XLSX/DOCX/imagens, usa `/reb/drive/download`
