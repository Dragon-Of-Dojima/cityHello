const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const SALT_ROUNDS = 10;

function ensureDataDir() {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, '[]');
  }
}

function readUsers() {
  ensureDataDir();
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
}

function writeUsers(users) {
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function findByEmail(email) {
  return readUsers().find(u => u.email === email.toLowerCase());
}

async function createUser({ firstName, lastName, phone, countryCode, email, password }) {
  const users = readUsers();
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    firstName,
    lastName,
    phone,
    countryCode,
    email: email.toLowerCase(),
    password: hash,
    onboardingComplete: false,
    onboardingData: {},
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);
  return user;
}

async function verifyPassword(email, password) {
  const user = findByEmail(email);
  if (!user) return null;
  const match = await bcrypt.compare(password, user.password);
  return match ? user : null;
}

function updateUser(id, updates) {
  const users = readUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return null;
  Object.assign(users[idx], updates);
  writeUsers(users);
  return users[idx];
}

function getUser(id) {
  return readUsers().find(u => u.id === id) || null;
}

module.exports = { findByEmail, createUser, verifyPassword, updateUser, getUser };
