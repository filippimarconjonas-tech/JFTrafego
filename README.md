# JF Tráfego - Landing Page

Landing page de serviços de marketing digital (tráfego pago, landing pages com/sem CRM).

- `public/index.html`: página completa (HTML, CSS e JS inline).
- `public/assets/`: logotipos.
- `wrangler.jsonc`: deploy como Worker de assets estáticos no Cloudflare (push na `main`).

## Configuração

No final de `public/index.html`, objeto `CONFIG`:

- `whatsapp`: número que recebe os leads (`5548984550552`).
- `webhookUrl`: URL opcional para enviar cada lead (CRM, Google Sheets via Apps Script, Make, Zapier, n8n).

Os eventos `lead_form_open` e `generate_lead` são enviados ao `dataLayer` (GTM) e ao Meta Pixel (`fbq`), se instalados.
