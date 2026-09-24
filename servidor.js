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
    
    // GUARDAR EN HISTÓRICO
    if (changeData.previous && changeData.new) {
      const agentId = ticket.assigned_agent ? ticket.assigned_agent.toString().split('|')[0] : null;
      await pool.query(
        `INSERT INTO ticket_state_history (ticket_id, previous_status, new_status, agent_id) 
         VALUES ($1, $2, $3, $4)`,
        [ticket.id, changeData.previous, changeData.new, agentId]
      );
    }

    console.log('✅ Datos guardados en PostgreSQL');
    res.json({ success: true, message: 'Datos guardados correctamente' });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Función helper para construir WHERE con filtro de fechas
const getDateFilter = (startDate, endDate) => {
  let filter = '';
  if (startDate && endDate) {
    filter = ` AND t.date_updated >= '${startDate}' AND t.date_updated <= '${endDate} 23:59:59'`;
  }
  return filter;
};

// API: Obtener KPIs principales
app.get('/api/kpis', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateFilter = getDateFilter(startDate, endDate);

    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN (1,2,3,4)) as tickets_abiertos,
        COUNT(*) FILTER (WHERE status = 5) as tickets_cerrados,
        COUNT(*) FILTER (WHERE status = 6) as tickets_spam,
        COUNT(*) as total_tickets,
        ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(date_closed, date_updated) - date_created)) / 3600)::numeric, 1) as tiempo_promedio_horas
      FROM support_candy_tickets t
      LEFT JOIN sc_agents a ON t.assigned_agent::text LIKE '%' || a.agent_id::text || '%'
      WHERE a.agent_id IN (22, 23, 17, 5, 3) ${dateFilter}
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
    const { startDate, endDate } = req.query;
    const dateFilter = getDateFilter(startDate, endDate);

    const result = await pool.query(`
      SELECT s.status_id, s.status_name_es, COUNT(DISTINCT t.ticket_id) as cantidad
      FROM sc_statuses s
      LEFT JOIN support_candy_tickets t ON t.status = s.status_id
      LEFT JOIN sc_agents a ON t.assigned_agent::text LIKE '%' || a.agent_id::text || '%'
      WHERE (a.agent_id IN (22, 23, 17, 5, 3) OR t.ticket_id IS NULL) ${dateFilter}
      GROUP BY s.status_id, s.status_name_es
      ORDER BY s.status_id ASC
    `);

    res.json({
      labels: result.rows.map(r => r.status_name_es),
      data: result.rows.map(r => parseInt(r.cantidad || 0))
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Obtener tickets por agente
app.get('/api/tickets-por-agente', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateFilter = getDateFilter(startDate, endDate);

    const result = await pool.query(`
      SELECT a.agent_id, a.agent_name, COUNT(DISTINCT t.ticket_id) as cantidad
      FROM sc_agents a
      LEFT JOIN support_candy_tickets t ON t.assigned_agent::text LIKE '%' || a.agent_id::text || '%'
      WHERE a.agent_id IN (22, 23, 17, 5, 3) ${dateFilter}
      GROUP BY a.agent_id, a.agent_name
      ORDER BY cantidad DESC
    `);

    res.json({
      labels: result.rows.map(r => r.agent_name),
      data: result.rows.map(r => parseInt(r.cantidad || 0))
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Obtener tickets por categoría
app.get('/api/tickets-por-categoria', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateFilter = getDateFilter(startDate, endDate);

    const result = await pool.query(`
      SELECT c.category_id, c.category_name, COUNT(DISTINCT t.ticket_id) as cantidad
      FROM sc_categories c
      LEFT JOIN support_candy_tickets t ON t.category = c.category_id
      LEFT JOIN sc_agents a ON t.assigned_agent::text LIKE '%' || a.agent_id::text || '%'
      WHERE a.agent_id IN (22, 23, 17, 5, 3) ${dateFilter}
      GROUP BY c.category_id, c.category_name
      ORDER BY cantidad DESC
    `);

    res.json({
      labels: result.rows.map(r => r.category_name),
      data: result.rows.map(r => parseInt(r.cantidad || 0))
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Obtener tickets por instancia
app.get('/api/tickets-por-instancia', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateFilter = getDateFilter(startDate, endDate);

    const result = await pool.query(`
      SELECT t.cust_26, COUNT(DISTINCT t.ticket_id) as cantidad
      FROM support_candy_tickets t
      LEFT JOIN sc_agents a ON t.assigned_agent::text LIKE '%' || a.agent_id::text || '%'
      WHERE a.agent_id IN (22, 23, 17, 5, 3) AND t.cust_26 IS NOT NULL AND t.cust_26 != '' ${dateFilter}
      GROUP BY t.cust_26
      ORDER BY cantidad DESC
      LIMIT 20
    `);

    res.json({
      labels: result.rows.map(r => r.cust_26),
      data: result.rows.map(r => parseInt(r.cantidad || 0))
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Obtener todos los tickets con detalles (SIN DUPLICADOS)
app.get('/api/tickets', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateFilter = getDateFilter(startDate, endDate);

    const result = await pool.query(`
      SELECT DISTINCT ON (t.ticket_id)
        t.ticket_id, t.subject, t.status, t.priority, t.assigned_agent, t.category, t.customer,
        t.date_created, t.date_updated, t.date_closed, t.cust_26,
        s.status_name_es,
        c.category_name,
        a.agent_name
      FROM support_candy_tickets t
      LEFT JOIN sc_statuses s ON t.status = s.status_id
      LEFT JOIN sc_categories c ON t.category = c.category_id
      LEFT JOIN sc_agents a ON (
        t.assigned_agent::text LIKE '%' || a.agent_id::text || '%' OR 
        CAST(SPLIT_PART(t.assigned_agent::text, '|', 1) AS INTEGER) = a.agent_id
      )
      WHERE a.agent_id IN (22, 23, 17, 5, 3) ${dateFilter}
      ORDER BY t.date_updated DESC
      LIMIT 200
    `);

    const priorityMap = {
      '1': 'Low', '2': 'Medium', '3': 'High', '4': 'Urgent'
    };

    res.json(result.rows.map(t => ({
      id: t.ticket_id,
      subject: t.subject,
      status: t.status_name_es || `Status ${t.status}`,
      priority: priorityMap[t.priority] || `Priority ${t.priority}`,
      agent: t.agent_name || 'Sin asignar',
      category: t.category_name || '-',
      customer: t.customer || '-',
      cust_26: t.cust_26 || '-',
      created: t.date_created ? new Date(t.date_created).toLocaleDateString('es-MX') : '-',
      updated: t.date_updated ? new Date(t.date_updated).toLocaleDateString('es-MX') : '-'
    })));

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Obtener histórico de un ticket
app.get('/api/ticket-timeline/:ticketId', async (req, res) => {
  try {
    const { ticketId } = req.params;

    const result = await pool.query(`
      SELECT 
        tsh.id,
        tsh.ticket_id,
        tsh.previous_status,
        tsh.new_status,
        tsh.agent_id,
        tsh.changed_at,
        s_prev.status_name_es as prev_status_name,
        s_new.status_name_es as new_status_name,
        a.agent_name,
        t.date_created,
        t.cust_26,
        t.subject
      FROM ticket_state_history tsh
      LEFT JOIN sc_statuses s_prev ON tsh.previous_status = s_prev.status_id
      LEFT JOIN sc_statuses s_new ON tsh.new_status = s_new.status_id
      LEFT JOIN sc_agents a ON tsh.agent_id = a.agent_id
      LEFT JOIN support_candy_tickets t ON tsh.ticket_id = t.ticket_id
      WHERE tsh.ticket_id = $1
      ORDER BY tsh.changed_at ASC
    `, [ticketId]);

    if (result.rows.length === 0) {
      return res.json({ 
        ticketId, 
        timeline: [],
        message: 'No hay histórico de cambios' 
      });
    }

    const firstRow = result.rows[0];
    const timeline = [];
    let currentTime = new Date(firstRow.date_created);

    // Agregar estado inicial
    timeline.push({
      status: 'Creado',
      startTime: new Date(firstRow.date_created),
      endTime: new Date(result.rows[0].changed_at),
      agent: 'Sistema',
      duration: Math.round((new Date(result.rows[0].changed_at) - new Date(firstRow.date_created)) / 3600000)
    });

    // Procesar cambios de estado
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i];
      const nextRow = result.rows[i + 1];
      const endTime = nextRow ? new Date(nextRow.changed_at) : new Date();

      timeline.push({
        status: row.new_status_name || `Estado ${row.new_status}`,
        startTime: new Date(row.changed_at),
        endTime: endTime,
        agent: row.agent_name || 'Sin asignar',
        duration: Math.round((endTime - new Date(row.changed_at)) / 3600000)
      });
    }

    res.json({
      ticketId,
      subject: firstRow.subject,
      instance: firstRow.cust_26,
      totalDuration: Math.round((timeline[timeline.length - 1].endTime - new Date(firstRow.date_created)) / 3600000),
      timeline
    });

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