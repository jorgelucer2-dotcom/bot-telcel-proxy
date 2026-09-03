// ============================================================
// 👥 BOT LEÓN - SISTEMA DE USUARIOS
// ============================================================

const fs = require('fs');
const path = require('path');

// Administrador principal del Bot León
const ADMIN_ID = 8354262550;

// Archivo donde se guardan los usuarios.
// En Render puede usarse BOT_DATA_DIR o USUARIOS_FILE
// para apuntar a almacenamiento persistente.
const DATA_DIR =
    process.env.BOT_DATA_DIR ||
    path.join(__dirname, '..', 'data');

const DATA_FILE =
    process.env.USUARIOS_FILE ||
    path.join(DATA_DIR, 'usuarios.json');

function asegurarArchivoUsuarios() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        if (!fs.existsSync(DATA_FILE)) {
            fs.writeFileSync(
                DATA_FILE,
                JSON.stringify({ usuarios: [] }, null, 2),
                'utf8'
            );
        }
    } catch (error) {
        console.error('❌ [USUARIOS] Error creando archivo:', error.message);
    }
}

function cargarUsuarios() {
    asegurarArchivoUsuarios();

    try {
        const contenido = fs.readFileSync(DATA_FILE, 'utf8');
        const datos = JSON.parse(contenido);

        if (!Array.isArray(datos.usuarios)) {
            return new Set();
        }

        return new Set(
            datos.usuarios
                .map(Number)
                .filter(id => Number.isInteger(id) && id > 0 && id !== ADMIN_ID)
        );
    } catch (error) {
        console.error('❌ [USUARIOS] Error leyendo usuarios:', error.message);
        return new Set();
    }
}

function guardarUsuarios(usuarios) {
    asegurarArchivoUsuarios();

    const datos = {
        usuarios: Array.from(usuarios)
            .map(Number)
            .filter(id => Number.isInteger(id) && id > 0 && id !== ADMIN_ID)
            .sort((a, b) => a - b)
    };

    fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(datos, null, 2),
        'utf8'
    );
}

const usuariosAutorizados = cargarUsuarios();

function esAdmin(id) {
    return Number(id) === ADMIN_ID;
}

function estaAutorizado(id) {
    const userId = Number(id);

    if (!Number.isInteger(userId)) return false;
    if (esAdmin(userId)) return true;

    return usuariosAutorizados.has(userId);
}

function agregarUsuario(id) {
    const userId = Number(id);

    if (!Number.isInteger(userId) || userId <= 0) {
        throw new Error('El ID de Telegram no es válido.');
    }

    if (esAdmin(userId)) {
        return { agregado: false, admin: true, id: userId };
    }

    if (usuariosAutorizados.has(userId)) {
        return { agregado: false, existente: true, id: userId };
    }

    usuariosAutorizados.add(userId);
    guardarUsuarios(usuariosAutorizados);

    return { agregado: true, id: userId };
}

function eliminarUsuario(id) {
    const userId = Number(id);

    if (!Number.isInteger(userId) || userId <= 0) {
        throw new Error('El ID de Telegram no es válido.');
    }

    if (esAdmin(userId)) {
        throw new Error('No puedes eliminar al administrador principal.');
    }

    const eliminado = usuariosAutorizados.delete(userId);

    if (eliminado) {
        guardarUsuarios(usuariosAutorizados);
    }

    return { eliminado, id: userId };
}

function listarUsuarios() {
    return Array.from(usuariosAutorizados).sort((a, b) => a - b);
}

function totalUsuarios() {
    return usuariosAutorizados.size;
}

function obtenerRutaUsuarios() {
    return DATA_FILE;
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
