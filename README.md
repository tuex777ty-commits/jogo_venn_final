# 🏛️ Portal de Venn — Online

Jogo educativo de conjuntos matemáticos com modo offline, salas online e ranking.

## ▶️ Rodar localmente

```bash
npm install
npm start
# Acesse http://localhost:3000
```

> Sem `DATABASE_URL`, usa arquivo `data/db.json` automaticamente.

## 🚀 Deploy no Render (gratuito)

### 1. Suba o código no GitHub
```bash
git init
git add .
git commit -m "Portal de Venn v1.1"
git remote add origin https://github.com/SEU_USUARIO/portal-de-venn.git
git push -u origin main
```

### 2. Deploy no Render
1. Acesse [render.com](https://render.com) e faça login com o GitHub
2. Clique em **New → Blueprint**
3. Selecione o repositório `portal-de-venn`
4. O Render lê o `render.yaml` e cria automaticamente:
   - ✅ O servidor Node.js
   - ✅ O banco de dados PostgreSQL (gratuito)
   - ✅ Liga os dois automaticamente via `DATABASE_URL`
5. Aguarde ~2 minutos e seu jogo estará em: `https://portal-de-venn-online.onrender.com`

### 3. Domínio personalizado (opcional)
1. Compre um domínio no [Registro.br](https://registro.br) (`.com.br`) ou [GoDaddy](https://godaddy.com)
2. No Render → seu serviço → **Settings → Custom Domains**
3. Clique em **Add Custom Domain** e digite seu domínio
4. O Render mostra um CNAME — copie e cole no painel DNS do seu domínio
5. Em ~5 minutos o jogo estará acessível pelo seu domínio com HTTPS grátis ✅

## 🗄️ Banco de dados

| Ambiente | Banco | Configuração |
|---|---|---|
| Local (dev) | JSON (`data/db.json`) | Automático, sem config |
| Produção (Render) | PostgreSQL | Via `DATABASE_URL` (automático pelo render.yaml) |

O servidor detecta automaticamente qual banco usar.
