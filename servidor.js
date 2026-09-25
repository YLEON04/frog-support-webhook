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

// Helper para campos multi-select (ej. cust_41 Impacto): guarda siempre como "6|7"
const normalizeMulti = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const ids = Array.isArray(value)
    ? value
    : value.toString().split(/[^0-9]+/);
  const clean = ids.map(v => v.toString().trim()).filter(v => v !== '');
  return clean.length ? clean.join('|') : null;
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
        assigned_agent = $8,
        category = $7,
        cust_41 = $48,
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
      ticket.time_spent || '', ticket.cust_40 || null, normalizeMulti(ticket.cust_41), ticket.cust_42 || '',
      changeData.previous || null, changeData.new || null, JSON.stringify(data)
    ];

    await pool.query(query, values);
    
    // GUARDAR EN HISTÓRICO
    if (changeData.previous && changeData.new) {
      const agentId = ticket.assigned_agent ? ticket.assigned_agent.toString().split('|')[0] : null;

      // Hora del cambio: se usa date_updated de Support Candy si es reciente (máx. 10 min atrás).
      // Así el retraso del webhook (Render dormido) no altera los tiempos.
      // Si no es confiable, se usa la hora de llegada del webhook (NOW()).
      let eventTime = null;
      const updated = fixDate(ticket.date_updated);
      if (updated) {
        const diffMs = Date.now() - new Date(updated.toString().replace(' ', 'T') + 'Z').getTime();
        if (!isNaN(diffMs) && diffMs >= -2 * 60 * 1000 && diffMs <= 10 * 60 * 1000) {
          eventTime = updated;
        }
      }

      await pool.query(
        `INSERT INTO ticket_state_history (ticket_id, previous_status, new_status, agent_id, changed_at) 
         VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))`,
        [ticket.id, changeData.previous, changeData.new, agentId, eventTime]
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
      LEFT JOIN support_candy_tickets t ON (
        t.assigned_agent::text = a.agent_id::text OR
        t.assigned_agent::text LIKE a.agent_id::text || '|%' OR
        t.assigned_agent::text LIKE '%|' || a.agent_id::text
      )
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

// API: Obtener tickets por impacto (cust_41, multi-select)
app.get('/api/tickets-por-impacto', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateFilter = getDateFilter(startDate, endDate);

    const result = await pool.query(`
      SELECT i.id, i.name, i.sort_order, COUNT(DISTINCT t.ticket_id) as cantidad
      FROM sc_impacts i
      LEFT JOIN (
        SELECT t.ticket_id, imp.val
        FROM support_candy_tickets t
        CROSS JOIN LATERAL regexp_split_to_table(t.cust_41::text, '[^0-9]+') AS imp(val)
        WHERE imp.val <> ''
          AND EXISTS (
            SELECT 1 FROM unnest(string_to_array(t.assigned_agent::text, '|')) AS ag(id)
            WHERE TRIM(ag.id) IN ('22', '23', '17', '5', '3')
          )
          ${dateFilter}
      ) t ON t.val::integer = i.id
      GROUP BY i.id, i.name, i.sort_order
      ORDER BY i.sort_order ASC
    `);

    res.json({
      labels: result.rows.map(r => r.name),
      data: result.rows.map(r => parseInt(r.cantidad || 0))
    });

  } catch (error) {
    console.error('Error en /api/tickets-por-impacto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Tickets abiertos con rezago (más de 3 días SIN contar el tiempo "Con cliente")
// No usa el filtro de fechas: siempre muestra lo que sigue abierto hoy
async function calcularRezagados() {
    // 1. Tickets abiertos del CAU con más de 3 días de antigüedad total
    //    (si el total no llega a 3 días, descontando al cliente tampoco llegará)
    const result = await pool.query(`
      SELECT DISTINCT ON (t.ticket_id)
        t.ticket_id, t.subject, t.cust_26, t.assigned_agent, t.date_created,
        s.status_name_es
      FROM support_candy_tickets t
      LEFT JOIN sc_statuses s ON t.status = s.status_id
      WHERE t.status IS NOT NULL
        AND t.status NOT IN (5, 6)
        AND t.date_created IS NOT NULL
        AND t.date_created <= NOW() - INTERVAL '3 days'
        AND EXISTS (
          SELECT 1 FROM unnest(string_to_array(t.assigned_agent::text, '|')) AS ag(id)
          WHERE TRIM(ag.id) IN ('22', '23', '17', '5', '3')
        )
      ORDER BY t.ticket_id, t.date_updated DESC
    `);

    const agentsResult = await pool.query('SELECT agent_id, agent_name FROM sc_agents');
    const agentMap = {};
    agentsResult.rows.forEach(a => { agentMap[a.agent_id.toString()] = a.agent_name; });

    // 2. Histórico de estados de esos tickets (una sola consulta)
    const ids = result.rows.map(r => r.ticket_id);
    const historyByTicket = {};
    if (ids.length > 0) {
      const hist = await pool.query(`
        SELECT tsh.ticket_id, tsh.changed_at,
               s_prev.status_name_es AS prev_name,
               s_new.status_name_es AS new_name
        FROM ticket_state_history tsh
        LEFT JOIN sc_statuses s_prev ON tsh.previous_status = s_prev.status_id
        LEFT JOIN sc_statuses s_new ON tsh.new_status = s_new.status_id
        WHERE tsh.ticket_id = ANY($1)
        ORDER BY tsh.ticket_id, tsh.changed_at ASC
      `, [ids]);
      hist.rows.forEach(h => {
        if (!historyByTicket[h.ticket_id]) historyByTicket[h.ticket_id] = [];
        historyByTicket[h.ticket_id].push(h);
      });
    }

    const normalize = (txt) => (txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const isCliente = (name) => normalize(name) === 'con cliente';
    const now = new Date();
    const DAY = 86400;

    // 3. Calcular tiempo total, tiempo con cliente y tiempo real de atención
    const tickets = result.rows.map(t => {
      const created = new Date(t.date_created);
      const totalSeconds = Math.max(0, (now - created) / 1000);
      const history = historyByTicket[t.ticket_id] || [];
      let clienteSeconds = 0;

      if (history.length > 0) {
        // Tramo inicial: desde la creación hasta el primer cambio
        if (isCliente(history[0].prev_name)) {
          clienteSeconds += Math.max(0, (new Date(history[0].changed_at) - created) / 1000);
        }
        // Cada estado dura hasta el siguiente cambio (o hasta hoy si es el actual)
        history.forEach((h, i) => {
          if (isCliente(h.new_name)) {
            const start = new Date(h.changed_at);
            const endT = history[i + 1] ? new Date(history[i + 1].changed_at) : now;
            clienteSeconds += Math.max(0, (endT - start) / 1000);
          }
        });
      }

      const atencionSeconds = Math.max(0, totalSeconds - clienteSeconds);
      const agentId = t.assigned_agent ? t.assigned_agent.toString().split('|')[0].trim() : null;
      const dias = Math.round((atencionSeconds / DAY) * 10) / 10;

      return {
        id: t.ticket_id,
        subject: t.subject || '',
        instance: t.cust_26 || '-',
        status: t.status_name_es || '-',
        agent: (agentId && agentMap[agentId]) || 'Sin asignar',
        dias,                                                      // sin contar tiempo con cliente
        diasTotales: Math.round((totalSeconds / DAY) * 10) / 10,
        diasCliente: Math.round((clienteSeconds / DAY) * 10) / 10,
        sinHistorico: history.length === 0,
        nivel: dias > 7 ? 'critico' : 'alerta'
      };
    })
    .filter(t => t.dias > 3)
    .sort((a, b) => b.dias - a.dias);

    return tickets;
}

app.get('/api/tickets-rezagados', async (req, res) => {
  try {
    const tickets = await calcularRezagados();

    res.json({
      total: tickets.length,
      alerta: tickets.filter(t => t.nivel === 'alerta').length,   // 3 a 7 días
      critico: tickets.filter(t => t.nivel === 'critico').length, // más de 7 días
      tickets
    });

  } catch (error) {
    console.error('Error en /api/tickets-rezagados:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Rendimiento por agente (usa el filtro de fechas)
app.get('/api/rendimiento-agentes', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateFilter = getDateFilter(startDate, endDate);
    const CAU_AGENTS = ['22', '23', '17', '5', '3'];

    const agentsResult = await pool.query(
      'SELECT agent_id, agent_name FROM sc_agents WHERE agent_id IN (22, 23, 17, 5, 3)'
    );

    // Base por agente
    const stats = {};
    agentsResult.rows.forEach(a => {
      stats[a.agent_id.toString()] = {
        agentId: a.agent_id,
        agent: a.agent_name,
        asignados: 0,
        cerrados: 0,
        abiertos: 0,
        reaccionSegundos: [],
        rezagados: 0
      };
    });

    // 1. Tickets del periodo (asignados, cerrados, abiertos)
    const ticketsResult = await pool.query(`
      SELECT DISTINCT ON (t.ticket_id) t.ticket_id, t.status, t.assigned_agent
      FROM support_candy_tickets t
      WHERE t.assigned_agent IS NOT NULL ${dateFilter}
      ORDER BY t.ticket_id, t.date_updated DESC
    `);

    const currentAgentByTicket = {};
    ticketsResult.rows.forEach(t => {
      const ids = t.assigned_agent.toString().split('|').map(v => v.trim());
      currentAgentByTicket[t.ticket_id] = ids[0];
      ids.filter(id => CAU_AGENTS.includes(id) && stats[id]).forEach(id => {
        const st = parseInt(t.status);
        if (st === 6) return; // spam no cuenta
        stats[id].asignados++;
        if (st === 5) stats[id].cerrados++;
        else stats[id].abiertos++;
      });
    });

    // 2. Tiempo de reacción: cuánto dura cada tramo en CAU antes de que el agente lo mueva
    const ticketIds = ticketsResult.rows.map(t => t.ticket_id);
    if (ticketIds.length > 0) {
      const hist = await pool.query(`
        SELECT tsh.ticket_id, tsh.agent_id, tsh.changed_at, s_new.status_name_es AS new_name
        FROM ticket_state_history tsh
        LEFT JOIN sc_statuses s_new ON tsh.new_status = s_new.status_id
        WHERE tsh.ticket_id = ANY($1)
        ORDER BY tsh.ticket_id, tsh.changed_at ASC
      `, [ticketIds]);

      const byTicket = {};
      hist.rows.forEach(h => {
        if (!byTicket[h.ticket_id]) byTicket[h.ticket_id] = [];
        byTicket[h.ticket_id].push(h);
      });

      const normalize = (txt) => (txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

      Object.keys(byTicket).forEach(ticketId => {
        const rows = byTicket[ticketId];
        rows.forEach((row, i) => {
          const next = rows[i + 1];
          // Solo tramos en CAU ya terminados (el agente ya lo movió)
          if (normalize(row.new_name) !== 'cau' || !next) return;
          const agentId = (next.agent_id || currentAgentByTicket[ticketId] || '').toString().trim();
          if (!stats[agentId]) return;
          const seconds = (new Date(next.changed_at) - new Date(row.changed_at)) / 1000;
          if (seconds >= 0) stats[agentId].reaccionSegundos.push(seconds);
        });
      });
    }

    // 3. Rezagados actuales (misma lógica que la gráfica de rezago)
    const rezagados = await calcularRezagados();
    const nameToId = {};
    Object.values(stats).forEach(s => { nameToId[s.agent] = s.agentId.toString(); });
    rezagados.forEach(t => {
      const id = nameToId[t.agent];
      if (id && stats[id]) stats[id].rezagados++;
    });

    // 4. Resultado
    const agentes = Object.values(stats).map(s => {
      const n = s.reaccionSegundos.length;
      const promedio = n ? s.reaccionSegundos.reduce((a, b) => a + b, 0) / n : null;
      return {
        agent: s.agent,
        asignados: s.asignados,
        cerrados: s.cerrados,
        abiertos: s.abiertos,
        tasaCierre: s.asignados ? Math.round((s.cerrados / s.asignados) * 100) : 0,
        reaccionHoras: promedio !== null ? Math.round((promedio / 3600) * 10) / 10 : null,
        tramosMedidos: n,
        rezagados: s.rezagados
      };
    }).sort((a, b) => b.cerrados - a.cerrados);

    res.json({ agentes });

  } catch (error) {
    console.error('Error en /api/rendimiento-agentes:', error.message);
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
        t.date_created, t.date_updated, t.date_closed, t.cust_26, t.cust_41, t.last_reply_by,
        s.status_name_es,
        c.category_name
      FROM support_candy_tickets t
      LEFT JOIN sc_statuses s ON t.status = s.status_id
      LEFT JOIN sc_categories c ON t.category = c.category_id
      WHERE t.ticket_id IS NOT NULL ${dateFilter}
      ORDER BY t.ticket_id DESC, t.date_updated DESC
      LIMIT 200
    `);

    const priorityMap = {
      '1': 'Low', '2': 'Medium', '3': 'High', '4': 'Urgent'
    };

    // Catálogo de impactos (una sola consulta)
    const impactResult = await pool.query('SELECT id, name FROM sc_impacts ORDER BY sort_order');
    const impactMap = {};
    impactResult.rows.forEach(r => { impactMap[r.id.toString()] = r.name; });

    const getImpactNames = (raw) => {
      if (!raw) return '-';
      const names = raw.toString().split(/[^0-9]+/)
        .filter(v => v !== '')
        .map(id => impactMap[id] || `Impacto ${id}`);
      return names.length ? names.join(', ') : '-';
    };

    // Obtener nombre del agente por separado
    const ticketsWithAgents = await Promise.all(result.rows.map(async (t) => {
      let agentName = 'Sin asignar';
      let agentId = null;

      // Intentar obtener del assigned_agent primero
      if (t.assigned_agent) {
        const agentIds = t.assigned_agent.toString().split('|');
        agentId = parseInt(agentIds[0]);
      }
      // Si no hay assigned_agent, intentar con last_reply_by
      else if (t.last_reply_by) {
        agentId = parseInt(t.last_reply_by);
      }

      if (agentId) {
        const agentResult = await pool.query(
          'SELECT agent_name FROM sc_agents WHERE agent_id = $1',
          [agentId]
        );
        if (agentResult.rows.length > 0) {
          agentName = agentResult.rows[0].agent_name;
        }
      }

      return {
        id: t.ticket_id,
        subject: t.subject,
        status: t.status_name_es || `Status ${t.status}`,
        priority: priorityMap[t.priority] || `Priority ${t.priority}`,
        agent: agentName,
        category: t.category_name || '-',
        customer: t.customer || '-',
        cust_26: t.cust_26 || '-',
        impact: getImpactNames(t.cust_41),
        created: t.date_created ? new Date(t.date_created).toLocaleDateString('es-MX') : '-',
        updated: t.date_updated ? new Date(t.date_updated).toLocaleDateString('es-MX') : '-'
      };
    }));

    res.json(ticketsWithAgents);

  } catch (error) {
    console.error('Error en /api/tickets:', error.message);
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
        t.subject,
        t.assigned_agent
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

    const rows = result.rows;
    const firstRow = rows[0];

    // Catálogo de agentes para resolver nombres
    const agentsResult = await pool.query('SELECT agent_id, agent_name FROM sc_agents');
    const agentMap = {};
    agentsResult.rows.forEach(a => { agentMap[a.agent_id.toString()] = a.agent_name; });
    const agentName = (id) => (id && agentMap[id.toString().trim()]) || null;

    // Agente asignado actualmente al ticket
    const currentAgentId = firstRow.assigned_agent
      ? firstRow.assigned_agent.toString().split('|')[0]
      : null;

    // Helper para convertir segundos a formato legible
    const formatDuration = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      
      let result = '';
      if (hours > 0) result += `${hours}h `;
      if (minutes > 0) result += `${minutes}m `;
      if (secs > 0 || result === '') result += `${secs}s`;
      
      return result.trim();
    };

    // Clasificar cada estado en un grupo
    const normalize = (txt) => (txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const getGroup = (statusName) => {
      const n = normalize(statusName);
      if (n === 'sin asignar') return 'espera';
      if (n === 'cau') return 'cau';
      if (n === 'con cliente') return 'cliente';
      if (n === 'cerrado') return 'cerrado';
      return 'otras'; // En validación, En programación, En consultoría, En ventas o negociación
    };

    const timeline = [];
    const createdTime = new Date(firstRow.date_created);
    const now = new Date();

    // Tramo inicial: desde la creación hasta el primer cambio de estado
    const initialStatus = firstRow.prev_status_name || 'Sin asignar';
    const initialGroup = getGroup(initialStatus);
    const firstChangeTime = new Date(firstRow.changed_at);
    const initialSeconds = Math.max(0, Math.floor((firstChangeTime - createdTime) / 1000));

    timeline.push({
      status: initialGroup === 'espera' ? 'En espera (sin asignar)' : initialStatus,
      group: initialGroup,
      startTime: createdTime,
      endTime: firstChangeTime,
      agent: initialGroup === 'espera' ? 'Sin asignar' : (agentName(firstRow.agent_id) || 'Sin asignar'),
      inProgress: false,
      durationSeconds: initialSeconds,
      durationFormatted: formatDuration(initialSeconds)
    });

    // Tramos por cada cambio de estado
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const nextRow = rows[i + 1];
      const statusName = row.new_status_name || `Estado ${row.new_status}`;
      const group = getGroup(statusName);
      const isLast = !nextRow;
      const startTime = new Date(row.changed_at);

      // Cerrado es el final: no acumula tiempo
      const endTime = nextRow ? new Date(nextRow.changed_at) : (group === 'cerrado' ? startTime : now);
      const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

      // Agente del tramo: el que quedó asignado durante ese estado
      // (se registra en el siguiente cambio; si es el estado actual, el asignado hoy)
      let agent;
      if (group === 'espera') {
        agent = 'Sin asignar';
      } else {
        const agentId = nextRow ? nextRow.agent_id : (currentAgentId || row.agent_id);
        agent = agentName(agentId) || row.agent_name || 'Sin asignar';
      }

      timeline.push({
        status: group === 'espera' ? 'En espera (sin asignar)' : statusName,
        group,
        startTime,
        endTime,
        agent,
        inProgress: isLast && group !== 'cerrado',
        durationSeconds,
        durationFormatted: group === 'cerrado' ? '-' : formatDuration(durationSeconds)
      });
    }

    // Resumen por grupo
    const summarySeconds = { espera: 0, cau: 0, otras: 0, cliente: 0 };
    timeline.forEach(item => {
      if (summarySeconds[item.group] !== undefined) {
        summarySeconds[item.group] += item.durationSeconds;
      }
    });

    const summary = {};
    Object.keys(summarySeconds).forEach(k => {
      summary[k] = {
        seconds: summarySeconds[k],
        formatted: formatDuration(summarySeconds[k])
      };
    });

    const lastItem = timeline[timeline.length - 1];
    const totalDurationSeconds = Math.max(0, Math.floor((lastItem.endTime - createdTime) / 1000));

    res.json({
      ticketId,
      subject: firstRow.subject,
      instance: firstRow.cust_26,
      isOpen: lastItem.group !== 'cerrado',
      totalDurationSeconds: totalDurationSeconds,
      totalDurationFormatted: formatDuration(totalDurationSeconds),
      summary,
      timeline
    });

  } catch (error) {
    console.error('Error en /api/ticket-timeline:', error.message);
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