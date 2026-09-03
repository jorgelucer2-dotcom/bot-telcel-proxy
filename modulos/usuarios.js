'use strict';

const fs = require('fs');
const path = require('path');

const ADMIN_ID = 8354262550;
const DATA_DIR = process.env.BOT_DATA_DIR || path.join(__dirname, '..', 'data');
const USUARIOS_FILE = process.env.USUARIOS_FILE || path.join(DATA_DIR, 'usuarios.json');

function asegurarArchivo() {
    try {
        fs.mkdirSync(path.dirname(USUARIOS_FILE), { recursive: true });
        if (!fs.existsSync(USUARIOS_FILE)) {
            fs.writeFileSync(USUARIOS_FILE, JSON.stringify({ usuarios: [] }, null, 2), 'utf8');
        }
    } catch (error) {
        console.error('[Usuarios] No se pudo preparar el archivo:', error.message || error);
    }
}

function cargarUsuarios() {
    asegurarArchivo();
    try {
        const raw = fs.readFileSync(USUARIOS_FILE, 'utf8');
        const data = JSON.parse(raw || '{"usuarios":[]}');
        const lista = Array.isArray(data) ? data : data.usuarios;
        return new Set((Array.isArray(lista) ? lista : []).map(String).filter(id => /^\d+$/.test(id)));
    } catch (error) {
        console.error('[Usuarios] No se pudo leer usuarios.json:', error.message || error);
        return new Set();
    }
}

function guardarUsuarios(setUsuarios) {
    asegurarArchivo();
    const lista = [...setUsuarios].map(String).filter(id => /^\d+$/.test(id));
    fs.writeFileSync(USUARIOS_FILE, JSON.stringify({ usuarios: lista }, null, 2), 'utf8');
    return lista;
}

function esAdmin(id) {
    return String(id || '') === String(ADMIN_ID);
}

function estaAutorizado(id) {
    const sid = String(id || '');
    return esAdmin(sid) || cargarUsuarios().has(sid);
}

function agregarUsuario(id) {
    const sid = String(id || '').trim();
    if (!/^\d+$/.test(sid)) return { ok: false, motivo: 'ID_INVALIDO' };
    if (esAdmin(sid)) return { ok: true, agregado: false, admin: true };

    const usuarios = cargarUsuarios();
    const yaExiste = usuarios.has(sid);
    usuarios.add(sid);
    guardarUsuarios(usuarios);
    return { ok: true, agregado: !yaExiste, id: sid };
}

function eliminarUsuario(id) {
    const sid = String(id || '').trim();
    if (!/^\d+$/.test(sid)) return { ok: false, motivo: 'ID_INVALIDO' };
    if (esAdmin(sid)) return { ok: false, motivo: 'NO_SE_PUEDE_ELIMINAR_ADMIN' };

    const usuarios = cargarUsuarios();
    const eliminado = usuarios.delete(sid);
    guardarUsuarios(usuarios);
    return { ok: true, eliminado, id: sid };
}

function listarUsuarios() {
    return [...cargarUsuarios()];
}

function totalUsuarios() {
    return listarUsuarios().length;
}

function obtenerRutaUsuarios() {
    return USUARIOS_FILE;
}

module.exports = {
    ADMIN_ID,
    esAdmin,
    estaAutorizado,
    agregarUsuario,
    eliminarUsuario,
    listarUsuarios,
    totalUsuarios,
    obtenerRutaUsuarios
};
