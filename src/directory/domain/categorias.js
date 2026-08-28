// directory/domain/categorias.js
// Catálogo oficial del Directorio Público de PYMEs
// 5 categorías + tipos de pyme (27 definidos + "Otros")
// Compartido por: DirectoryView (login) y ConfigEditor (admin)

export const CATEGORIAS_DIRECTORIO = [
    {
        id: 'salud',
        nombre: 'Salud y Bienestar Clínico',
        icono: 'fa-heartbeat',
        descripcion: 'Profesionales que manejan expedientes, notas privadas o salud de pacientes/clientes.',
        tipos: [
            'Odontólogos',
            'Psicólogos',
            'Terapeutas',
            'Fonoaudiólogos (Terapia del lenguaje)',
            'Kinesiólogos / Fisioterapeutas',
            'Nutricionistas'
        ]
    },
    {
        id: 'estetica',
        nombre: 'Estética, Belleza y Cuidado Personal',
        icono: 'fa-spa',
        descripcion: 'Servicios de salón, gabinetes o atención directa de imagen y relajación.',
        tipos: [
            'Peluqueros',
            'Manicuristas',
            'Barberos',
            'Maquillistas (Make-up Artists)',
            'Esteticistas y Cosmetólogas',
            'Masajistas / Masoterapeutas'
        ]
    },
    {
        id: 'deporte',
        nombre: 'Deporte, Actividad Física y Clases',
        icono: 'fa-dumbbell',
        descripcion: 'Entrenadores, instructores y gestión de horarios o cupos recurrentes.',
        tipos: [
            'Entrenadores',
            'Dueños de Centros de Yoga o Pilates',
            'Entrenadores de Deportes Específicos (Tenis, Fútbol, Golf)',
            'Instructores de Música (Guitarra, canto, piano)',
            'Academias de Baile',
            'Tutores Particulares / Profesores de Idiomas'
        ]
    },
    {
        id: 'profesionales',
        nombre: 'Servicios Profesionales y Creativos',
        icono: 'fa-briefcase',
        descripcion: 'Profesionales independientes, estudios y agendamiento de reuniones o proyectos largos.',
        tipos: [
            'Abogados, Consultores o Contadores',
            'Fotógrafos (Estudio o exteriores)',
            'Tatuadores (Gestión de horas largas y anticipos)',
            'Diseñadores Gráficos / Web Freelancers',
            'Veterinarios (Consultas para mascotas)'
        ]
    },
    {
        id: 'tecnicos',
        nombre: 'Servicios Técnicos, Hogar y Terreno',
        icono: 'fa-tools',
        descripcion: 'PYMEs cuyas reservas implican visitas a domicilio o traslados geográficos.',
        tipos: [
            'Técnicos de Reparación de Electrodomésticos / Aire Acondicionado',
            'Plomeros / Electricistas / Gasfíters',
            'Empresas de Limpieza de Alfombras / Sofás',
            'Guías de Turismo (Tours privados o excursiones)',
            'Dueños de Canchas de Fútbol / Pádel / Tenis (Alquiler de espacios)'
        ]
    }
];

// Opción extra #28: cualquier otro rubro
export const TIPO_PYME_OTRO = 'Otros';

/** Devuelve la categoría por id (o null) */
export function getCategoria(id) {
    return CATEGORIAS_DIRECTORIO.find(c => c.id === id) || null;
}

/** Devuelve todos los tipos posibles de una categoría + "Otros" */
export function getTiposDeCategoria(categoriaId) {
    const cat = getCategoria(categoriaId);
    if (!cat) return [TIPO_PYME_OTRO];
    return [...cat.tipos, TIPO_PYME_OTRO];
}
