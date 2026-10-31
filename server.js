const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const webpush = require('web-push');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8, pingTimeout: 60000 });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const VAPID_PUBLIC_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const VAPID_PRIVATE_KEY = 'UUxI4O8-FbRouAevSmBQ6o18hgL2G7mjG2g1gK2dX2I';
webpush.setVapidDetails('mailto:admin@classxi5.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    store: new pgSession({ pool: pool, tableName: 'session', createTableIfMissing: true }),
    secret: 'super-secret-key-class-xi5',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.get('/health', (req, res) => res.status(200).send('OK'));

async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY, username TEXT UNIQUE, password TEXT, plain_password TEXT, 
                role TEXT DEFAULT 'siswa', full_name TEXT, avatar_url TEXT, about TEXT DEFAULT 'Tersedia', 
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP, is_online BOOLEAN DEFAULT FALSE
            );
            CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, subject TEXT, title TEXT, description TEXT, due_date TIMESTAMP, created_by INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY, sender_id INTEGER, receiver_id INTEGER, 
                message TEXT, media TEXT, media_type TEXT, is_read BOOLEAN DEFAULT FALSE, 
                reply_to_id INTEGER, reactions JSONB DEFAULT '{}', is_deleted BOOLEAN DEFAULT FALSE, 
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS stories (id SERIAL PRIMARY KEY, user_id INTEGER, media TEXT, media_type TEXT, text TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS schedules (id SERIAL PRIMARY KEY, day TEXT, start_time TEXT, end_time TEXT, subject TEXT, teacher TEXT, room TEXT);
        `);
        
        const res = await client.query(`SELECT * FROM users WHERE username = 'admin'`);
        if (res.rows.length === 0) {
            const hash = bcrypt.hashSync('admin123', 10);
            await client.query(`INSERT INTO users (username, password, plain_password, role, full_name) VALUES ('admin', $1, 'admin123', 'admin', 'ADMIN-REX')`, [hash]);
        }
    } catch (err) { console.error('DB Init Error:', err); } finally { client.release(); }
}

const requireAuth = (req, res, next) => { if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' }); next(); };
const requireAdmin = (req, res, next) => { if (req.session.role !== 'admin') return res.status(403).json({ error: 'Forbidden' }); next(); };

// --- AUTH ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
        const user = result.rows[0];
        if (user && bcrypt.compareSync(password, user.password)) {
            req.session.userId = user.id; req.session.role = user.role; req.session.fullName = user.full_name;
            await pool.query(`UPDATE users SET is_online = true WHERE id = $1`, [user.id]);
            res.json({ success: true, role: user.role });
        } else res.status(401).json({ success: false, message: 'Username atau password salah' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/logout', async (req, res) => { 
    if(req.session.userId) await pool.query(`UPDATE users SET is_online = false, last_seen = CURRENT_TIMESTAMP WHERE id = $1`, [req.session.userId]);
    req.session.destroy(); res.json({ success: true }); 
});

app.get('/api/me', requireAuth, async (req, res) => {
    const result = await pool.query(`SELECT id, role, full_name, avatar_url, about FROM users WHERE id = $1`, [req.session.userId]);
    res.json(result.rows[0]);
});

app.post('/api/profile/update', requireAuth, async (req, res) => {
    const { avatar, about } = req.body;
    if(avatar) await pool.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [avatar, req.session.userId]);
    if(about) await pool.query(`UPDATE users SET about = $1 WHERE id = $2`, [about, req.session.userId]);
    res.json({ success: true });
});

// --- ADMIN PANEL ---
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    const result = await pool.query(`SELECT id, username, plain_password, full_name, role, is_online FROM users ORDER BY id ASC`);
    res.json(result.rows);
});
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
    if (req.params.id == req.session.userId) return res.status(400).json({error: 'Tidak bisa hapus diri sendiri'});
    await pool.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
});

// --- TUGAS & JADWAL ---
app.get('/api/tasks', requireAuth, async (req, res) => { const r = await pool.query(`SELECT * FROM tasks ORDER BY created_at DESC`); res.json(r.rows); });
app.post('/api/tasks', requireAuth, requireAdmin, async (req, res) => {
    const { subject, title, due_date } = req.body;
    await pool.query(`INSERT INTO tasks (subject, title, due_date) VALUES ($1, $2, $3)`, [subject, title, due_date]);
    io.emit('new_notif', { title: 'Tugas Baru!', msg: `Mapel ${subject}: ${title}` });
    res.json({ success: true });
});
app.delete('/api/tasks/:id', requireAuth, requireAdmin, async (req, res) => { await pool.query(`DELETE FROM tasks WHERE id = $1`, [req.params.id]); res.json({ success: true }); });

app.get('/api/schedules', requireAuth, async (req, res) => { const r = await pool.query(`SELECT * FROM schedules ORDER BY day ASC`); res.json(r.rows); });
app.post('/api/schedules', requireAuth, requireAdmin, async (req, res) => {
    const { day, start_time, end_time, subject, teacher, room } = req.body;
    await pool.query(`INSERT INTO schedules (day, start_time, end_time, subject, teacher, room) VALUES ($1, $2, $3, $4, $5, $6)`, [day, start_time, end_time, subject, teacher, room]);
    io.emit('new_notif', { title: 'Jadwal Baru!', msg: `Hari ${day}: ${subject}` });
    res.json({ success: true });
});

// --- CHAT & KONTAK ---
app.get('/api/users', requireAuth, async (req, res) => {
    const result = await pool.query(`SELECT id, full_name, avatar_url, about, is_online, last_seen FROM users WHERE id != $1`, [req.session.userId]);
    res.json(result.rows);
});

app.get('/api/messages/:receiverId', requireAuth, async (req, res) => {
    const receiverId = req.params.receiverId;
    let result;
    if (receiverId === 'group') {
        result = await pool.query(`SELECT m.*, u.full_name, r.message as reply_text, r.full_name as reply_sender FROM messages m JOIN users u ON m.sender_id = u.id LEFT JOIN messages r ON m.reply_to_id = r.id WHERE m.receiver_id IS NULL ORDER BY m.created_at ASC LIMIT 150`);
    } else {
        result = await pool.query(`SELECT m.*, u.full_name, r.message as reply_text, r.full_name as reply_sender FROM messages m JOIN users u ON m.sender_id = u.id LEFT JOIN messages r ON m.reply_to_id = r.id WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1) ORDER BY m.created_at ASC LIMIT 150`, [req.session.userId, receiverId]);
    }
    res.json(result.rows);
});

// --- STATUS/STORY ---
app.get('/api/stories', requireAuth, async (req, res) => {
    const r = await pool.query(`SELECT s.*, u.full_name, u.avatar_url FROM stories s JOIN users u ON s.user_id = u.id WHERE s.created_at >= NOW() - INTERVAL '24 HOURS' ORDER BY s.created_at DESC`);
    res.json(r.rows);
});
app.post('/api/stories', requireAuth, async (req, res) => {
    await pool.query(`INSERT INTO stories (user_id, media, media_type, text) VALUES ($1, $2, $3, $4)`, [req.session.userId, req.body.media, req.body.media_type, req.body.text]);
    res.json({ success: true });
});

// --- SOCKET.IO CORE ---
const activeSockets = new Map();

io.on('connection', (socket) => {
    socket.on('user_online', async (userId) => {
        socket.userId = userId;
        activeSockets.set(userId, socket.id);
        io.emit('user_status', { userId, status: 'online' });
    });

    socket.on('disconnect', async () => {
        if (socket.userId) {
            activeSockets.delete(socket.userId);
            await pool.query(`UPDATE users SET last_seen = CURRENT_TIMESTAMP, is_online = false WHERE id = $1`, [socket.userId]);
            io.emit('user_status', { userId: socket.userId, status: 'offline', last_seen: new Date() });
        }
    });

    socket.on('join_chat', (data) => { if (data.room === 'group') socket.join('group_chat'); else socket.join(`user_${data.userId}`); });
    
    socket.on('typing', (data) => {
        if(data.receiver_id === 'group') socket.to('group_chat').emit('user_typing', { sender_id: data.sender_id, name: data.name, isTyping: data.isTyping });
        else socket.to(`user_${data.receiver_id}`).emit('user_typing', { sender_id: data.sender_id, name: data.name, isTyping: data.isTyping });
    });

    socket.on('send_message', async (data) => {
        const { sender_id, receiver_id, message, media, media_type, sender_name, reply_to_id } = data;
        const dbReceiverId = (receiver_id === 'group') ? null : receiver_id;
        
        try {
            const result = await pool.query(`INSERT INTO messages (sender_id, receiver_id, message, media, media_type, reply_to_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`, [sender_id, dbReceiverId, message, media, media_type, reply_to_id]);
            
            let replyText = null, replySender = null;
            if(reply_to_id) {
                const r = await pool.query(`SELECT message, full_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = $1`, [reply_to_id]);
                if(r.rows.length > 0) { replyText = r.rows[0].message; replySender = r.rows[0].full_name; }
            }

            const msgData = { 
                id: result.rows[0].id, sender_id, receiver_id: dbReceiverId, message, media, media_type, 
                reply_to_id, reply_text: replyText, reply_sender: replySender, 
                full_name: sender_name, is_read: false, reactions: {}, created_at: result.rows[0].created_at 
            };
            
            if (dbReceiverId === null) io.to('group_chat').emit('receive_message', msgData);
            else { 
                io.to(`user_${receiver_id}`).emit('receive_message', msgData); 
                socket.emit('receive_message', msgData); 
                // Push Notif jika offline
                const subs = await pool.query(`SELECT * FROM subscriptions WHERE user_id = $1`, [receiver_id]);
                if(subs.rows.length > 0) {
                    subs.rows.forEach(sub => {
                        webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({ title: `Pesan dari ${sender_name}`, body: message || '[Media]', url: '/chat' })).catch(e => {});
                    });
                }
            }
        } catch(e) { console.log(e); }
    });

    socket.on('mark_as_read', async (data) => {
        const { chat_id, current_user_id } = data;
        let query = chat_id === 'group' 
            ? `UPDATE messages SET is_read = true WHERE receiver_id IS NULL AND sender_id != $1 AND is_read = false RETURNING id, sender_id`
            : `UPDATE messages SET is_read = true WHERE sender_id = $1 AND receiver_id = $2 AND is_read = false RETURNING id, sender_id`;
        const res = await pool.query(query, chat_id === 'group' ? [current_user_id] : [chat_id, current_user_id]);
        res.rows.forEach(row => { io.to(`user_${row.sender_id}`).emit('message_read_status', { message_id: row.id }); });
    });

    socket.on('delete_message', async (data) => {
        const { message_id, chat_id } = data;
        await pool.query(`UPDATE messages SET is_deleted = true, message = 'Pesan ini telah dihapus', media = null WHERE id = $1`, [message_id]);
        if (chat_id === 'group') io.to('group_chat').emit('message_deleted', { message_id });
        else { io.to(`user_${chat_id}`).emit('message_deleted', { message_id }); socket.emit('message_deleted', { message_id }); }
    });

    socket.on('react_message', async (data) => {
        const { message_id, emoji, chat_id, user_id } = data;
        const msg = await pool.query(`SELECT reactions FROM messages WHERE id = $1`, [message_id]);
        let reactions = msg.rows[0].reactions || {};
        if(reactions[user_id] === emoji) delete reactions[user_id]; // Toggle
        else reactions[user_id] = emoji;
        
        await pool.query(`UPDATE messages SET reactions = $1 WHERE id = $2`, [JSON.stringify(reactions), message_id]);
        if (chat_id === 'group') io.to('group_chat').emit('message_reaction', { message_id, reactions });
        else { io.to(`user_${chat_id}`).emit('message_reaction', { message_id, reactions }); socket.emit('message_reaction', { message_id, reactions }); }
    });

    // WebRTC
    socket.on('callUser', (data) => { io.to(`user_${data.userToCall}`).emit('callUser', data); });
    socket.on('answerCall', (data) => { io.to(`user_${data.to}`).emit('callAccepted', data.signal); });
    socket.on('endCall', (data) => { io.to(`user_${data.to}`).emit('endCall'); });
});

app.get('/', (req, res) => { if (req.session.userId) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/dashboard', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/chat', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'chat.html')); });
app.get('/status', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'status.html')); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`Server on ${PORT}`); initDB().catch(console.error); });