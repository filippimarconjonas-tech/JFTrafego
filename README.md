# JF Tráfego - Landing Page + CRM

- `public/index.html`: landing page (HTML, CSS e JS inline).
- `public/admin/`: CRM (funil de vendas) em `/admin`, protegido por senha.
- `src/worker.js`: Worker da Cloudflare. Serve o site e a API (`/api/leads`, `/api/login`, `/api/admin/*`).
- Banco: Cloudflare D1 `jftrafego-crm` (tabelas criadas automaticamente na primeira requisição).
- Deploy: push na `main` (Workers Builds executa `npm run build` e `npx wrangler deploy`).

## Senha do CRM

Defina o secret `ADMIN_PASSWORD` no Cloudflare: Workers & Pages > jftrafego > Settings > Variables and Secrets > Add > tipo "Secret".
Trocar a senha desconecta todas as sessões abertas.

## Qualificação automática

Pelo faturamento mensal informado no formulário:

- **A**: acima de R$ 100 mil
- **B**: de R$ 10 mil a R$ 100 mil
- **C**: abaixo de R$ 10 mil

Sem faturamento ("Prefiro não informar"), a classe é estimada pela verba de anúncios (acima de R$ 10.000 = A; R$ 1.000 a R$ 10.000 = B; até R$ 1.000 ou sem verba = C). Sem nenhum dos dois, fica "Sem dados". Prazo "Imediatamente" marca o lead como quente. A classe pode ser alterada manualmente no CRM.

## Etapas do funil

Novo lead → Em contato → Call agendada → Call realizada → Proposta enviada → Follow-up → Cliente fechado / Perdido / Nutrição.

## Desenvolvimento local

```
npm install
echo "ADMIN_PASSWORD=teste" > .dev.vars
npx wrangler dev
```
