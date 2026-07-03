// catalog/ui/CartSidebar.js
// Sidebar/carrito de compras para la vista cliente
// Muestra items agregados, total y boton de confirmar reserva

import { getCarrito, suscribirseCarrito, quitarDelCarrito, vaciarCarrito, totalCarrito, confirmarReserva } from '../application/CatalogService.js';
import { formatearDinero, formatTimeDisplay } from '../../shared/infrastructure/formatters.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

let _sidebarAbierto = false;

export function initCartSidebar(containerId = 'cart-sidebar-container') {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Crear estructura si no existe
    if (!document.getElementById('cart-sidebar')) {
        container.innerHTML = `
            <div id="cart-sidebar" class="cart-sidebar ${_sidebarAbierto ? 'open' : ''}">
                <div class="cart-header">
                    <h3><i class="fas fa-shopping-cart"></i> Carrito</h3>
                    <button id="cart-toggle-btn" class="cart-toggle">
                        <i class="fas fa-chevron-${_sidebarAbierto ? 'right' : 'left'}"></i>
                    </button>
                </div>
                <div id="cart-items" class="cart-items">
                    <p class="cart-empty">Carrito vacio</p>
                </div>
                <div class="cart-footer" id="cart-footer" style="display:none">
                    <div class="cart-total">
                        <span>Total:</span>
                        <strong id="cart-total-amount">$0</strong>
                    </div>
                    <button id="cart-checkout-btn" class="btn-primary btn-full">
                        <i class="fas fa-check-circle"></i> Confirmar Reserva
                    </button>
                    <button id="cart-clear-btn" class="btn-text btn-full">
                        Vaciar carrito
                    </button>
                </div>
            </div>
        `;

        // Toggle sidebar
        document.getElementById('cart-toggle-btn').addEventListener('click', () => {
            _sidebarAbierto = !_sidebarAbierto;
            const sidebar = document.getElementById('cart-sidebar');
            sidebar.classList.toggle('open');
            document.getElementById('cart-toggle-btn').innerHTML = `<i class="fas fa-chevron-${_sidebarAbierto ? 'right' : 'left'}"></i>`;
        });

        // Vaciar
        document.getElementById('cart-clear-btn')?.addEventListener('click', () => {
            if (!confirm('¿Vaciar carrito?')) return;
            vaciarCarrito();
            mostrarToast('Carrito vaciado', 'info');
        });

        // Checkout
        document.getElementById('cart-checkout-btn').addEventListener('click', handleCheckout);
    }

    // Suscribirse a cambios
    suscribirseCarrito(renderCart);
}

function renderCart(items) {
    const container = document.getElementById('cart-items');
    const footer = document.getElementById('cart-footer');
    if (!container) return;

    if (!items.length) {
        container.innerHTML = '<p class="cart-empty"><i class="fas fa-shopping-bag"></i> Carrito vacio</p>';
        if (footer) footer.style.display = 'none';
        return;
    }

    container.innerHTML = items.map(item => `
        <div class="cart-item">
            <div class="cart-item-info">
                <strong>${escapeHtml(item.nombre)}</strong>
                <small>${item.fecha} - ${formatTimeDisplay(item.hora)}</small>
                <span>${formatearDinero(item.precio)}</span>
            </div>
            <button class="cart-item-remove" data-carrito-id="${item.carritoId}">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `).join('');

    container.querySelectorAll('.cart-item-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            quitarDelCarrito(btn.dataset.carritoId);
        });
    });

    document.getElementById('cart-total-amount').textContent = formatearDinero(totalCarrito());
    if (footer) footer.style.display = 'block';
}

async function handleCheckout() {
    const session = window.getClienteSession ? window.getClienteSession() : null;
    if (!session) {
        mostrarToast('Debes ingresar tus datos primero', 'error');
        return;
    }

    const items = getCarrito();
    if (!items.length) {
        mostrarToast('Carrito vacio', 'warning');
        return;
    }

    const contacto = {
        nombre: session.nombre || 'Cliente',
        email: session.email || '',
        telefono: session.whatsapp || ''
    };

    const btn = document.getElementById('cart-checkout-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reservando...'; }

    try {
        await confirmarReserva(contacto);
        mostrarToast('Reserva confirmada exitosamente', 'success');
        if (typeof renderMisReservas === 'function') renderMisReservas();
        renderCart([]);
    } catch (err) {
        mostrarToast('Error: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check-circle"></i> Confirmar Reserva'; }
    }
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}