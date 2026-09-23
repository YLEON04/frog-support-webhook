require('dotenv').config();
const express = require('express');
const path = require('path');
const mssql = require('mssql');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

// Configuración SQL Server
const sqlConfig = {
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DATABASE,
  authentication: {
    type: 'default',
    options: {
      userName: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD
    }
  },
  options: {
    encrypt: true,
    trustServerCertificate: true,
    connectionTimeout: 30000,
    requestTimeout: 30000,
  }
};

// Crear tabla si no existe
async function initDatabase() {
  try {
    const pool = new mssql.ConnectionPool(sqlConfig);
    await pool.connect();
    
    const query = `
      IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'SUPPORT_CANDY_TICKETS')
      CREATE TABLE SUPPORT_CANDY_TICKETS (
        ID INT PRIMARY KEY IDENTITY(1,1),
        TICKET_ID NVARCHAR(50) UNIQUE,
        STATUS NVARCHAR(20),
        PRIORITY NVARCHAR(20),
        SUBJECT NVARCHAR(500),
        CUSTOMER_EMAIL NVARCHAR(100),
        CREATED_AT DATETIME,
        UPDATED_AT DATETIME,
        MESSAGE_COUNT INT,
        TAGS NVARCHAR(MAX),
        DATA_JSON NVARCHAR(MAX),
        INSERTED_AT DATETIME DEFAULT GETDATE()
      );
    `;
    
    await pool.request().query(query);
    await pool.close();
    console.log('✅ Base de datos verificada/creada');
  } catch (error) {
    console.warn('⚠️ Error en DB init:', error.message);
  }
}

// WEBHOOK: Recibir datos de Support Candy
app.post('/webhook/support-candy', async (req, res) => {
  try {
    const ticket = req.body;
    console.log('✅ Webhook recibido - Ticket:', ticket.id);
    
    const pool = new mssql.ConnectionPool(sqlConfig);
    await pool.connect();
    
    const request = pool.request();
    request.input('ticket_id', mssql.VarChar(50), ticket.id || 'N/A');
    request.input('status', mssql.VarChar(20), ticket.status || 'unknown');
    request.input('priority', mssql.VarChar(20), ticket.priority || 'normal');
    request.input('subject', mssql.VarChar(500), ticket.subject || '');
    request.input('customer_email', mssql.VarChar(100), ticket.customer_email || '');
    request.input('created_at', mssql.DateTime, ticket.created_at || new Date());
    request.input('updated_at', mssql.DateTime, new Date());
    request.input('message_count', mssql.Int, ticket.message_count || 0);
    request.input('tags', mssql.NVarChar(mssql.MAX), JSON.stringify(ticket.tags || []));
    request.input('data_json', mssql.NVarChar(mssql.MAX), JSON.stringify(ticket));
    
    const query = `
      MERGE INTO SUPPORT_CANDY_TICKETS AS target
      USING (SELECT @ticket_id as TICKET_ID) AS source
      ON target.TICKET_ID = source.TICKET_ID
      WHEN MATCHED THEN
        UPDATE SET 
          STATUS = @status,
          PRIORITY = @priority,
          SUBJECT = @subject,
          UPDATED_AT = @updated_at,
          MESSAGE_COUNT = @message_count,
          DATA_JSON = @data_json
      WHEN NOT MATCHED THEN
        INSERT (TICKET_ID, STATUS, PRIORITY, SUBJECT, CUSTOMER_EMAIL, CREATED_AT, UPDATED_AT, MESSAGE_COUNT, TAGS, DATA_JSON)
        VALUES (@ticket_id, @status, @priority, @subject, @customer_email, @created_at, @updated_at, @message_count, @tags, @data_json);
    `;
    
    await request.query(query);
    await pool.close();
    
    res.json({ success: true, message: 'Datos guardados correctamente' });
    
  } catch (error) {
    console.error('❌ Error en webhook:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Obtener estadísticas
app.get('/api/stats', async (req, res) => {
  try {
    const pool = new mssql.ConnectionPool(sqlConfig);
    await pool.connect();
    
    const result = await pool.request().query(`
      SELECT 
        ISNULL(STATUS, 'unknown') as STATUS,
        COUNT(*) as CANTIDAD,
        CAST(AVG(CAST(DATEDIFF(HOUR, CREATED_AT, UPDATED_AT) AS FLOAT)) AS INT) as AVG_HOURS
      FROM SUPPORT_CANDY_TICKETS
      WHERE CREATED_AT > DATEADD(DAY, -30, GETDATE())
      GROUP BY STATUS
      ORDER BY CANTIDAD DESC
    `);
    
    await pool.close();
    
    const recordset = result.recordset || [];
    const open = recordset.find(r => r.STATUS === 'open')?.CANTIDAD || 0;
    const closed = recordset.find(r => r.STATUS === 'closed')?.CANTIDAD || 0;
    const avgHours = recordset[0]?.AVG_HOURS || 0;
    
    res.json({
      open,
      closed,
      avgHours,
      statusLabels: recordset.map(r => r.STATUS.toUpperCase()),
      statusCounts: recordset.map(r => r.CANTIDAD)
    });
    
  } catch (error) {
    console.error('❌ Error en API:', error.message);
    res.status(500).json({ 
      error: error.message,
      open: 0,
      closed: 0,
      avgHours: 0,
      statusLabels: [],
      statusCounts: []
    });
  }
});

// Servir dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// Inicializar y arrancar
const PORT = process.env.PORT || 3000;
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📊 Dashboard en: http://localhost:${PORT}`);
  });
});