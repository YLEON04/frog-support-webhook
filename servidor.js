require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

// Configuración PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Helper para convertir fechas inválidas a null
const fixDate = (dateStr) => {
  if (!dateStr || dateStr.includes('0000-00-00')) {
    return null;
  }
  return dateStr;
};

// WEBHOOK: Recibir datos de Support Candy
app.post('/webhook/support-candy', async (req, res) => {
  try {
    const data = req.body;
    console.log('✅ Webhook recibido');
    
    const ticket = data.ticket || (data.payload && data.payload.ticket);
    const changeData = data.data || (data.payload && data.payload.data) || {};

    if (!ticket) {
      console.log('⚠️ Estructura inválida - no hay ticket');
      return res.json({ success: false, message: 'Estructura inválida' });
    }

    const query = `
      INSERT INTO support_candy_tickets 
      (ticket_id, is_active, customer, subject, status, priority, category, assigned_agent, 
       date_created, date_updated, agent_created, ip_address, source, browser, os, prev_assignee, 
       date_closed, user_type, last_reply_on, last_reply_by, last_reply_source, auth_code, tags, 
       live_agents, misc, frd, ard, cd, cg, cust_26, cust_28, cust_29, cust_30, cust_31, cust_32, 
       cust_33, cust_34, pin, rating, sf_feedback, sf_date, sla, od_count, od_email, sla_policy, 
       time_spent, cust_40, cust_41, cust_42, previous_status, new_status, data_json)
      VALUES 
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 
       $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36,
       $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51, $52)
      ON CONFLICT (ticket_id) DO UPDATE SET
        status = $5,
        priority = $6,
        subject = $4,
        date_updated = $10,
        last_reply_on = $19,
        last_reply_by = $20,
        previous_status = $50,
        new_status = $51,
        data_json = $52;
    `;

    const values = [
      ticket.id, ticket.is_active || 0, ticket.customer || null, ticket.subject || '',
      ticket.status || null, ticket.priority || null, ticket.category || null, ticket.assigned_agent || null,
      fixDate(ticket.date_created), fixDate(ticket.date_updated), ticket.agent_created || null,
      ticket.ip_address || '', ticket.source || '', ticket.browser || '', ticket.os || '',
      ticket.prev_assignee || '', fixDate(ticket.date_closed), ticket.user_type || '',
      fixDate(ticket.last_reply_on), ticket.last_reply_by || null, ticket.last_reply_source || '',
      ticket.auth_code || '', ticket.tags || '', ticket.live_agents || '', ticket.misc || '',
      ticket.frd || null, ticket.ard || null, ticket.cd || null, ticket.cg || null,
      ticket.cust_26 || '', ticket.cust_28 || '', ticket.cust_29 || '', ticket.cust_30 || '',
      ticket.cust_31 || '', ticket.cust_32 || '', ticket.cust_33 || '', fixDate(ticket.cust_34),
      ticket.pin || 0, ticket.rating || 0, ticket.sf_feedback || '', fixDate(ticket.sf_date),
      fixDate(ticket.sla), ticket.od_count || 0, ticket.od_email || 0, ticket.sla_policy || 0,
      ticket.time_spent || '', ticket.cust_40 || null, ticket.cust_41 || null, ticket.cust_42 || '',
      changeData.previous || null, changeData.new || null, JSON.stringify(data)
    ];

    await pool.query(query, values);
    console.log('✅ Datos guardados en PostgreSQL');
    res.json({ success: true, message: 'Datos guardados correctamente' });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/// API: Obtener KPIs principales
app.get('/api/kpis', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN (1,2,3,4)) as tickets_abiertos,
        COUNT(*) FILTER (WHERE status = 5) as tickets_cerrados,
        COUNT(*) FILTER (WHERE status = 6) as tickets_spam,
        COUNT(*) as total_tickets,
        ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(date_closed, date_updated) - date_created)) / 3600)::numeric, 1) as tiempo_promedio_horas
      FROM support_candy_tickets
    `);

    const row = result.rows[0];
    res.json({
      tickets_abiertos: parseInt(row.tickets_abiertos || 0),
      tickets_cerrados: parseInt(row.tickets_cerrados || 0),
      tickets_spam: parseInt(row.tickets_spam || 0),
      total_tickets: parseInt(row.total_tickets || 0),
      tiempo_promedio_horas: parseFloat(row.tiempo_promedio_horas || 0)
    });

  } catch (error) {
    console.error('❌ Error en KPIs:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Obtener tickets por estado
app.get('/api/tickets-por-estado', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT status, COUNT(*) as cantidad
      FROM support_candy_tickets
      GROUP BY status
      ORDER BY status ASC
    `);

    const statusMap = {
      '1': 'New', '2': 'Open', '3': 'On Hold', '4': 'Waiting for Customer', '5': 'Closed', '6': 'Spam'
    };

    res.json({
      labels: result.rows.map(r => statusMap[r.status] || `Status ${r.status}`),
      data: result.rows.map(r => parseInt(r.cantidad))
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Obtener tickets por agente
app.get('/api/tickets-por-agente', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT assigned_agent, COUNT(*) as cantidad
      FROM support_candy_tickets
      WHERE assigned_agent IS NOT NULL
      GROUP BY assigned_agent
      ORDER BY cantidad DESC
      LIMIT 10
    `);

    res.json({
      labels: result.rows.map((r, i) => r.assigned_agent || `Agent ${i + 1}`),
      data: result.rows.map(r => parseInt(r.cantidad))
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Obtener tickets por categoría
app.get('/api/tickets-por-categoria', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT category, COUNT(*) as cantidad
      FROM support_candy_tickets
      WHERE category IS NOT NULL
      GROUP BY category
      ORDER BY cantidad DESC
      LIMIT 10
    `);

    res.json({
      labels: result.rows.map(r => `Cat ${r.category}`),
      data: result.rows.map(r => parseInt(r.cantidad))
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Obtener todos los tickets con detalles
app.get('/api/tickets', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        ticket_id, subject, status, priority, assigned_agent, category, customer,
        date_created, date_updated, date_closed, cust_26
      FROM support_candy_tickets
      ORDER BY date_updated DESC
      LIMIT 100
    `);

    const statusMap = {
      '1': 'New', '2': 'Open', '3': 'On Hold', '4': 'Waiting for Customer', '5': 'Closed', '6': 'Spam'
    };

    const priorityMap = {
      '1': 'Low', '2': 'Medium', '3': 'High', '4': 'Urgent'
    };

    res.json(result.rows.map(t => ({
      id: t.ticket_id,
      subject: t.subject,
      status: statusMap[t.status] || `Status ${t.status}`,
      priority: priorityMap[t.priority] || `Priority ${t.priority}`,
      agent: t.assigned_agent || 'Sin asignar',
      category: t.category || '-',
      customer: t.customer || '-',
      cust_26: t.cust_26 || '-',
      created: t.date_created ? new Date(t.date_created).toLocaleDateString('es-MX') : '-',
      updated: t.date_updated ? new Date(t.date_updated).toLocaleDateString('es-MX') : '-'
    })));

  } catch (error) {
    res.status(500).json({ error: error.message });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});