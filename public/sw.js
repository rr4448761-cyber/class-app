const CACHE_NAME = 'class-app-v3';
const ASSET = ['/chat', 'manifest.json'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
    e.respondWith(caches.match(e.request).then(res => res || fetch(e.request)));
});

self.addEventListener('push', (e) => {
    if (!e.data) return;
    const data = e.data.json();
    const options = {
        body: data.body,
        icon: 'https://ui-avatars.com/api/?name=XI&background=6c5ce7&color=fff&size=192',
        badge: 'https://ui-avatars.com/api/?name=XI&background=6c5ce7&color=fff&size=96',
        vibrate: [200, 100, 200, 100, 200],
        data: { url: data.url || '/dashboard' },
        actions: [
            { action: 'open', title: 'Buka Aplikasi' },
            { action: 'close', title: 'Tutup' }
        ]
    };
    e.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    if (e.action === 'close') return;
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            for (let client of clientList) {
                if (client.url.includes(e.notification.data.url) && 'focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(e.notification.data.url);
        })
    );
});