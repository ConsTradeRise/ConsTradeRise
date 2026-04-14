'use strict';
const { PrismaClient } = require('@prisma/client');

// Single shared PrismaClient instance for the entire app.
// Prevents connection pool exhaustion (Supabase free tier: 60 connections).
const prisma = global._prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') global._prisma = prisma;

module.exports = prisma;
