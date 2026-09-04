═══════════════════════════════════════════════════════════════
  FROG SUPPORT WEBHOOK - SETUP EN RENDER
═══════════════════════════════════════════════════════════════

PASO 1: Crear cuenta en GitHub
─────────────────────────────
1. Ve a https://github.com/signup
2. Crea cuenta (o usa la que tengas)
3. Listo

PASO 2: Crear repositorio en GitHub
─────────────────────────────
1. Ve a https://github.com/new
2. Nombre: frog-support-webhook
3. Descripción: "Support Candy webhook server"
4. Public (importante!)
5. "Create repository"

PASO 3: Subir archivos a GitHub
─────────────────────────────
1. Entra al repo que creaste
2. Click "Add file" → "Upload files"
3. Sube estos archivos:
   - server.js
   - package.json
   - .gitignore
4. Click "Commit changes"

PASO 4: Crear servicio en Render
─────────────────────────────
1. Ve a https://render.com (crea cuenta si no tienes)
2. Dashboard → "New +" → "Web Service"
3. Conecta tu repo de GitHub (autoriza)
4. Selecciona: frog-support-webhook
5. Configura:
   - Name: frog-support-webhook
   - Environment: Node
   - Region: (donde quieras, ej: Oregon)
   - Build Command: npm install
   - Start Command: npm start
6. Plan: Free (está bien)
7. Click "Create Web Service"

PASO 5: Esperar deployment
─────────────────────────────
1. Render va a compilar e iniciar el servidor (2-3 minutos)
2. Cuando esté listo, verás un ✓ verde
3. Te mostrará una URL tipo:
   https://frog-support-webhook.onrender.com
   (LA URL PUEDE SER DIFERENTE A ESTA)

PASO 6: Copiar la URL
─────────────────────────────
1. Copia la URL que Render te da
2. En tu dashboard HTML, en el sidebar:
   - Pega en el campo "Servidor Webhook"
   - Click "Probar Conexión"
   - Debe decir "✅ Conectado"

PASO 7: Configurar webhook en Support Candy
─────────────────────────────
1. Login en Support Candy
2. Settings → Webhooks (o Integraciones)
3. Click "Add Webhook"
4. URL: https://frog-support-webhook.onrender.com/webhook
   (REEMPLAZA CON LA URL REAL DE RENDER)
5. Method: POST
6. Events: Ticket Updated, Ticket Closed
7. Save

PASO 8: Usar el dashboard
─────────────────────────────
1. Abre tu dashboard HTML
2. En el sidebar, ingresa la URL del servidor
3. Click "✓ Probar Conexión"
4. Click "🔄 Auto-refresh ON"
5. ¡LISTO! Se actualiza automáticamente cada 5 minutos

═══════════════════════════════════════════════════════════════

❓ PROBLEMAS COMUNES:

"No conecta"
→ Espera 2-3 minutos a que Render inicie
→ Verifica que la URL sea exacta
→ Copia desde el dashboard de Render

"No llegan tickets"
→ Verifica que el webhook esté configurado en Support Candy
→ Ve a Render → Logs para ver si llega el POST

"¿A qué URL envío desde Support Candy?"
→ La URL que Render te da + "/webhook"
→ Ejemplo: https://frog-support-webhook.onrender.com/webhook

═══════════════════════════════════════════════════════════════
