# Landing page do squadchat

Site estático da landing page do squadchat, no design system "turno da noite": céu em pixel art, manchetes em
Instrument Serif, âmbar como cor de ação e os robôs dos agentes desenhados pelo mesmo motor do app.

Não tem dependências nem bundler: HTML, CSS e JavaScript em módulos, com fontes e assets locais. O build só copia
`src/` para `dist/`.

## Estrutura

```
landing/
├── package.json        scripts de dev, build e preview
├── scripts/
│   ├── build.mjs       gera dist/ a partir de src/
│   └── serve.mjs       servidor estático local
└── src/                o site (é isto que vai para o ar)
    ├── index.html
    ├── styles.css      todos os tokens do design system ficam no :root
    ├── app.js          header, baralho de recursos e botão de copiar
    ├── hero-swarm.js   céu, órbita do hero e a rodada de trabalho do time
    ├── scenes.js       cenas em pixel art dos capítulos, cartas e rodapé
    ├── _headers        cabeçalhos de cache do Cloudflare Pages
    ├── favicon.svg
    └── assets/
        ├── brand/      marca do squadchat (SVG)
        ├── fonts/      Instrument Serif, Instrument Sans, JetBrains Mono, Bricolage Grotesque (OFL, com licenças)
        └── vendor/     agent-engine.js, o desenhador dos robôs (cópia de packages/ui/src/agent/engine.js)
```

## Rodar localmente

Precisa de Node 18 ou mais novo. A página usa módulos JavaScript, então abra por `http://`, não com duplo clique
no arquivo.

```sh
cd landing
npm run dev        # serve src/ em http://localhost:8788
```

Para usar outra porta: `PORT=3000 npm run dev`.

## Build

```sh
cd landing
npm run build      # gera landing/dist/
npm run preview    # serve dist/ em http://localhost:8788 para conferir
```

Com Bun também funciona: `bun run build`, `bun run dev`.

## Publicar no Cloudflare Pages

### Pelo painel (Git integration)

Em **Workers & Pages → Create → Pages → Connect to Git**, escolha este repositório e use:

| Campo                  | Valor           |
| ---------------------- | --------------- |
| Production branch      | `main`          |
| Framework preset       | `None`          |
| Root directory         | `landing`       |
| Build command          | `npm run build` |
| Build output directory | `dist`          |

Não precisa de variáveis de ambiente. Como não há dependências, a instalação é instantânea.

Para publicar só quando a landing mudar, em **Settings → Builds → Build watch paths** use `landing/*`.

### Pela linha de comando (Wrangler)

```sh
cd landing
npm run build
npx wrangler pages deploy dist --project-name squadchat-landing
```

Na primeira vez o Wrangler pede login na Cloudflare e cria o projeto.

## Editar

- **Cores, tipos, espaços e movimento:** variáveis no início de `src/styles.css` e no bloco do hero.
- **Textos:** direto em `src/index.html`.
- **Conversa dos agentes no hero:** lista `LINES` em `src/hero-swarm.js`.
- **Rodada de trabalho do time:** lista `STEPS` em `src/hero-swarm.js`.
- **Cenas dos capítulos:** objeto `SCENES` em `src/scenes.js`.

Quem prefere menos movimento (`prefers-reduced-motion`) vê tudo parado, e as animações só rodam quando a seção
está visível.

## Licença e atribuição

Faz parte do squadchat, um fork do squadchat, e segue a mesma licença: GNU AGPL-3.0-only. O rodapé mantém a
atribuição exigida pela seção 7(b) do NOTICE: "Based on agentes.chat by AGENTESCHAT, LLC".
`src/assets/vendor/agent-engine.js` é uma cópia sem alterações de `packages/ui/src/agent/engine.js`. As fontes são
OFL, com os arquivos de licença em `src/assets/fonts/`.
