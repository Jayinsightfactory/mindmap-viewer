const dbModule = require('./src/db.js');
const db = dbModule.getDb();

if (!db) {
  console.log('No database available');
  process.exit(0);
}

try {
  // Users 확인
  console.log('=== USERS ===');
  const users = db.prepare('SELECT id, email, name FROM users LIMIT 5').all();
  console.log(JSON.stringify(users, null, 2));
  
  // Collaborators 확인
  console.log('\n=== COLLABORATORS ===');
  const collab = db.prepare('SELECT * FROM collaborators LIMIT 10').all();
  console.log(JSON.stringify(collab, null, 2));
  
  // Nodes 확인
  console.log('\n=== NODES ===');
  const nodes = db.prepare('SELECT * FROM nodes LIMIT 5').all();
  console.log(JSON.stringify(nodes, null, 2));
  
  // 테이블 목록
  console.log('\n=== ALL TABLES ===');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log(tables.map(t => t.name).join(', '));
  
} catch(e) {
  console.error('Error:', e.message);
}
