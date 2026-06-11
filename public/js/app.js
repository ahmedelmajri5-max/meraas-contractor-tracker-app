/**
 * MERAAS Contractor Tracker - Frontend Core JavaScript
 * Handles Authentication, Tab switching, Odoo Data Rendering, and Interactive Filters
 */

// Global App State
const state = {
    user: null,
    token: null,
    orders: [],
    contractors: [],
    activeTab: 'dashboard',
    quickFilter: 'all',
    searchQuery: '',
    statusFilter: 'all',
    projectFilter: 'all',
    costCenterFilter: 'all',
    sortOrder: 'newest',
    selectedPartnerId: ''
};

const API_BASE = window.location.origin;

// Initialize App on DOM Load
document.addEventListener("DOMContentLoaded", () => {
    initApp();
    setupEventListeners();
    const table = document.getElementById("orders-table");
    if (table) {
        initResizableColumns(table);
    }
});

// Check auth state & route
function initApp() {
    // Current date
    const dateEl = document.getElementById("current-date");
    if (dateEl) {
        dateEl.textContent = new Date().toLocaleDateString('ar-LY', {
            year: 'numeric', month: 'long', day: 'numeric'
        });
    }

    const savedUser = localStorage.getItem("meraas_user");
    const savedToken = localStorage.getItem("meraas_token");

    if (savedUser && savedToken) {
        state.user = JSON.parse(savedUser);
        state.token = savedToken;
        showMainApp();
    } else {
        showLoginScreen();
    }
}

// ─── AUTHENTICATION FLOWS ──────────────────────────────────────────────────

function showLoginScreen() {
    document.getElementById("login-screen").classList.remove("hidden");
    document.getElementById("register-screen").classList.add("hidden");
    document.getElementById("app-layout").classList.add("hidden");
}

function showRegisterScreen() {
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("register-screen").classList.remove("hidden");
    document.getElementById("app-layout").classList.add("hidden");
}

function showMainApp() {
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("register-screen").classList.add("hidden");
    document.getElementById("app-layout").classList.remove("hidden");

    // Display user profile info
    document.getElementById("user-display-name").textContent = state.user.name;
    document.getElementById("user-role").textContent = state.user.role === 'admin' ? 'إدارة ميراس' : 'متعهد معتمد';

    // Show admin options if user is admin
    const adminMenu = document.getElementById("menu-admin");
    const adminSelector = document.getElementById("admin-contractor-selector-wrapper");
    if (state.user.role === 'admin') {
        adminMenu.classList.remove("hidden");
        adminSelector.classList.remove("hidden");
        fetchContractorsList().then(() => {
            populateAdminContractorSelect();
            // Automatically select the first contractor with work orders to populate data immediately
            const select = document.getElementById("admin-contractor-select");
            if (select && select.options.length > 1 && !state.selectedPartnerId) {
                let targetIndex = 1;
                for (let i = 1; i < select.options.length; i++) {
                    const optText = select.options[i].text;
                    if (!optText.includes("(0 أمر عمل)")) {
                        targetIndex = i;
                        break;
                    }
                }
                select.selectedIndex = targetIndex;
                state.selectedPartnerId = select.value;
                refreshData();
            }
        });
    } else {
        adminMenu.classList.add("hidden");
        adminSelector.classList.add("hidden");
        refreshData();
    }
}

function populateAdminContractorSelect() {
    const select = document.getElementById("admin-contractor-select");
    if (!select) return;

    let html = '<option value="">اختر المتعهد واستعرض حسابه...</option>';
    const sorted = [...state.contractors].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    sorted.forEach(c => {
        html += `<option value="${c.id}">${c.name} (${c.po_count} أمر عمل)</option>`;
    });
    select.innerHTML = html;
}

function handleLogout() {
    localStorage.removeItem("meraas_user");
    localStorage.removeItem("meraas_token");
    state.user = null;
    state.token = null;
    state.orders = [];
    state.selectedPartnerId = '';
    showLoginScreen();
}

// ─── DATA FETCHING & API INTERACTION ───────────────────────────────────────

async function refreshData() {
    showLoader();
    try {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.token}`
        };

        let queryParams = "";
        if (state.user.role === 'admin') {
            if (state.selectedPartnerId) {
                queryParams = `?partner_id=${state.selectedPartnerId}`;
            } else {
                renderDashboardStats({
                    total_orders: 0, draft_count: 0, confirmed_count: 0, completed_count: 0,
                    total_value: 0, total_paid: 0, total_under_process: 0, total_remaining: 0
                });
                state.orders = [];
                applyFiltersAndRender();
                return;
            }
        }

        // Fetch Dashboard Stats
        const dashRes = await fetch(`${API_BASE}/api/dashboard${queryParams}`, { headers });
        if (dashRes.status === 401) return handleLogout();
        const dashData = await dashRes.json();
        if (!dashData.error) {
            renderDashboardStats(dashData);
        }

        // Fetch Work Orders
        const woRes = await fetch(`${API_BASE}/api/work_orders${queryParams}`, { headers });
        const woData = await woRes.json();
        if (!woData.error) {
            state.orders = woData;
            populateFiltersOptions();
            applyFiltersAndRender();
        }

        // Fetch Admin Contractors list if admin
        if (state.user.role === 'admin') {
            fetchContractorsList().then(() => {
                renderAdminPanel();
                populateAdminContractorSelect();
                const select = document.getElementById("admin-contractor-select");
                if (select) select.value = state.selectedPartnerId;
            });
        }

    } catch (err) {
        console.error("API error:", err);
    } finally {
        hideLoader();
    }
}

async function fetchContractorsList() {
    try {
        const res = await fetch(`${API_BASE}/api/contractors`, {
            headers: { 'Authorization': `Bearer ${state.token}` }
        });
        const data = await res.json();
        if (!data.error) {
            state.contractors = data;
            renderAdminPanel();
        }
    } catch (err) {
        console.error(err);
    }
}

// ─── RENDERING FUNCTIONS ───────────────────────────────────────────────────

function renderDashboardStats(stats) {
    document.getElementById("stat-total-orders").textContent = stats.total_orders;
    document.getElementById("stat-draft-orders").textContent = stats.draft_count;
    document.getElementById("stat-confirmed-orders").textContent = stats.confirmed_count;
    document.getElementById("stat-completed-orders").textContent = stats.completed_count;

    document.getElementById("stat-total-value").textContent = formatCurrency(stats.total_value);
    document.getElementById("stat-total-paid").textContent = formatCurrency(stats.total_paid);
    document.getElementById("stat-total-under").textContent = formatCurrency(stats.total_under_process);
    document.getElementById("stat-total-remaining").textContent = formatCurrency(stats.total_remaining);
}

function populateFiltersOptions() {
    const projectFilter = document.getElementById("filter-project");
    const costCenterFilter = document.getElementById("filter-cost-center");

    const projects = new Set();
    const costCenters = new Set();

    state.orders.forEach(o => {
        if (o.location) projects.add(o.location);
        if (o.cost_center) costCenters.add(o.cost_center);
    });

    // Populate Location selector
    projectFilter.innerHTML = '<option value="all">المشروع (الكل)</option>';
    projects.forEach(p => {
        projectFilter.innerHTML += `<option value="${p}">${p}</option>`;
    });

    // Populate Cost Center selector
    costCenterFilter.innerHTML = '<option value="all">مركز التكلفة (الكل)</option>';
    costCenters.forEach(cc => {
        costCenterFilter.innerHTML += `<option value="${cc}">${cc}</option>`;
    });
}

function applyFiltersAndRender() {
    let filtered = [...state.orders];

    // Search Box query filter
    if (state.searchQuery) {
        const query = state.searchQuery.toLowerCase();
        filtered = filtered.filter(o => 
            o.po_number.toLowerCase().includes(query) ||
            o.invoice_no.toLowerCase().includes(query) ||
            o.location.toLowerCase().includes(query) ||
            o.cost_center.toLowerCase().includes(query) ||
            o.contractor_name.toLowerCase().includes(query)
        );
    }

    // Status filter dropdown
    if (state.statusFilter !== 'all') {
        filtered = filtered.filter(o => o.state === state.statusFilter);
    }

    // Project Location filter dropdown
    if (state.projectFilter !== 'all') {
        filtered = filtered.filter(o => o.location === state.projectFilter);
    }

    // Cost center filter dropdown
    if (state.costCenterFilter !== 'all') {
        filtered = filtered.filter(o => o.cost_center === state.costCenterFilter);
    }

    // Quick filter navigation tabs
    if (state.quickFilter === 'under_process') {
        filtered = filtered.filter(o => o.under_process_amount > 0);
    } else if (state.quickFilter === 'paid') {
        filtered = filtered.filter(o => o.paid_amount > 0 && o.remaining_amount === 0 && o.under_process_amount === 0);
    } else if (state.quickFilter === 'remaining') {
        filtered = filtered.filter(o => o.remaining_amount > 0);
    }

    // Sorting
    if (state.sortOrder === 'newest') {
        filtered.sort((a, b) => new Date(b.write_date) - new Date(a.write_date));
    } else if (state.sortOrder === 'highest-val') {
        filtered.sort((a, b) => b.total_amount - a.total_amount);
    } else if (state.sortOrder === 'highest-rem') {
        filtered.sort((a, b) => b.remaining_amount - a.remaining_amount);
    }

    renderTable(filtered);
    renderMobileCards(filtered);
    renderDashboardAlerts(filtered);
}

function renderTable(orders) {
    const tbody = document.getElementById("orders-table-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (orders.length === 0) {
        tbody.innerHTML = `<tr><td colspan="13" style="text-align: center; padding: 40px; color: var(--text-secondary);">لا توجد أي أوامر عمل تطابق الفلاتر المحددة.</td></tr>`;
        return;
    }

    let html = "";
    orders.forEach(o => {
        const stateClass = getStateClass(o.state);
        
        // Build reference pills for Paid Payments
        let paidPillsHTML = '';
        if (o.paid_payment_refs && o.paid_payment_refs.length > 0) {
            paidPillsHTML = `<div class="payment-refs-container">` + 
                o.paid_payment_refs.map(ref => `<span class="ref-pill pill-paid"><i class="fa-solid fa-circle-check"></i> ${ref}</span>`).join('') +
                `</div>`;
        }

        // Build reference pills for Under Process Payments
        let underProcPillsHTML = '';
        if (o.under_process_payment_refs && o.under_process_payment_refs.length > 0) {
            underProcPillsHTML = `<div class="payment-refs-container">` +
                o.under_process_payment_refs.map(ref => `<span class="ref-pill pill-processing"><i class="fa-solid fa-hourglass-half"></i> ${ref}</span>`).join('') +
                `</div>`;
        }

        // Google Drive link button
        const driveHTML = o.vendor_reference 
            ? `<a href="${o.vendor_reference}" target="_blank" class="drive-btn" title="فتح المستند في Google Drive"><i class="fa-brands fa-google-drive"></i> رابط</a>`
            : `<span class="drive-btn-disabled" title="لا يوجد رابط مرفق"><i class="fa-solid fa-link-slash"></i> -</span>`;

        html += `
            <tr>
                <td style="font-weight: 700;">${o.po_number}</td>
                <td><span class="state-badge ${stateClass}">${o.state}</span></td>
                <td>${o.location}</td>
                <td style="font-size: 0.8rem; max-width: 150px; overflow: hidden; text-overflow: ellipsis;" title="${o.cost_center}">${o.cost_center}</td>
                <td>${driveHTML}</td>
                <td>${o.invoice_no}</td>
                <td class="amount-display">${formatNumber(o.total_amount)}<span class="currency-symbol">د.ل</span></td>
                <td>
                    <span class="amount-display text-warning" style="font-weight: 700;">${formatNumber(o.under_process_amount)}<span class="currency-symbol">د.ل</span></span>
                    ${underProcPillsHTML}
                </td>
                <td>${o.under_process_date}</td>
                <td>
                    <span class="amount-display text-success" style="font-weight: 700;">${formatNumber(o.paid_amount)}<span class="currency-symbol">د.ل</span></span>
                    ${paidPillsHTML}
                </td>
                <td>${o.paid_date}</td>
                <td class="amount-display" style="font-weight: 700; color: ${o.remaining_amount > 0 ? 'var(--color-danger)' : 'var(--text-secondary)'}">
                    ${formatNumber(o.remaining_amount)}<span class="currency-symbol">د.ل</span>
                </td>
                <td>
                    <button class="btn btn-icon btn-sm" onclick="openDetailsModal(${o.id})" style="width: 32px; height: 32px;" title="عرض تفاصيل الدفعات">
                        <i class="fa-solid fa-magnifying-glass-plus" style="font-size: 0.85rem;"></i>
                    </button>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
}

function renderMobileCards(orders) {
    const container = document.getElementById("orders-cards-container");
    if (!container) return;
    container.innerHTML = "";

    if (orders.length === 0) {
        container.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--text-secondary);">لا توجد أي أوامر عمل.</div>`;
        return;
    }

    let html = "";
    orders.forEach(o => {
        const stateClass = getStateClass(o.state);
        const driveHTML = o.vendor_reference 
            ? `<a href="${o.vendor_reference}" target="_blank" class="drive-btn"><i class="fa-brands fa-google-drive"></i> فتح Drive</a>`
            : `<span class="drive-btn-disabled">-</span>`;

        html += `
            <div class="mobile-card glass-panel">
                <div class="mobile-card-header">
                    <h4>أمر عمل: ${o.po_number}</h4>
                    <span class="state-badge ${stateClass}">${o.state}</span>
                </div>
                <div class="mobile-card-row">
                    <span class="label">الموقع:</span>
                    <span>${o.location}</span>
                </div>
                <div class="mobile-card-row">
                    <span class="label">إجمالي القيمة:</span>
                    <span class="amount-display">${formatNumber(o.total_amount)} د.ل</span>
                </div>
                <div class="mobile-card-row">
                    <span class="label">تحت الإجراء:</span>
                    <span class="amount-display text-warning">${formatNumber(o.under_process_amount)} د.ل</span>
                </div>
                <div class="mobile-card-row">
                    <span class="label">المدفوع:</span>
                    <span class="amount-display text-success">${formatNumber(o.paid_amount)} د.ل</span>
                </div>
                <div class="mobile-card-row">
                    <span class="label">المتبقي:</span>
                    <span class="amount-display text-danger">${formatNumber(o.remaining_amount)} د.ل</span>
                </div>
                <div class="mobile-card-row" style="margin-top: 10px; border-top: 1px solid var(--border-color); padding-top: 10px;">
                    <span>${driveHTML}</span>
                    <button class="btn btn-primary" onclick="openDetailsModal(${o.id})" style="padding: 6px 12px; font-size: 0.8rem;">
                        <i class="fa-solid fa-magnifying-glass-plus"></i> التفاصيل الكاملة
                    </button>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
}

function renderDashboardAlerts(orders) {
    const container = document.getElementById("dashboard-alerts");
    const badge = document.getElementById("alert-count-badge");
    if (!container || !badge) return;
    
    // Find all orders with under process amounts
    const pendingOrders = orders.filter(o => o.under_process_amount > 0);
    
    badge.textContent = `${pendingOrders.length} معاملة معلقة`;

    if (pendingOrders.length === 0) {
        container.innerHTML = `
            <div class="alert-empty-state">
                <i class="fa-solid fa-circle-check text-success"></i>
                <p>جميع سداداتك تم تسويتها أو لا توجد سدادات معلقة لدى المالية حالياً.</p>
            </div>
        `;
        return;
    }

    let html = "";
    pendingOrders.forEach(o => {
        const refsStr = o.under_process_payment_refs && o.under_process_payment_refs.length > 0
            ? ` (سداد رقم: ${o.under_process_payment_refs.join('، ')})`
            : '';

        html += `
            <div class="alert-item">
                <div class="alert-item-left">
                    <i class="fa-solid fa-circle-exclamation text-warning"></i>
                    <div class="alert-item-text">
                        <h5>قيمة تحت الإجراء بقيمة ${formatNumber(o.under_process_amount)} د.ل</h5>
                        <p>لأمر العمل رقم ${o.po_number}${refsStr} - موقع ${o.location}</p>
                    </div>
                </div>
                <button class="btn btn-icon btn-sm" onclick="openDetailsModal(${o.id})" title="استعراض التفاصيل">
                    <i class="fa-solid fa-chevron-left"></i>
                </button>
            </div>
        `;
    });
    container.innerHTML = html;
}

function renderAdminPanel() {
    // Populate Map Partner Selector dropdown
    const partnerSelect = document.getElementById("map-partner");
    if (partnerSelect) {
        let html = '<option value="">اختر المورد/المتعهد...</option>';
        // Sort contractors alphabetically
        const sorted = [...state.contractors].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        sorted.forEach(c => {
            html += `<option value="${c.id}">${c.name} (${c.po_count} أمر عمل)</option>`;
        });
        partnerSelect.innerHTML = html;
    }

    // Populate contractors list table
    const tbody = document.getElementById("admin-contractors-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (state.contractors.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">لا يوجد أي متعهدون نشطون.</td></tr>`;
        return;
    }

    let tbodyHTML = "";
    state.contractors.forEach(c => {
        tbodyHTML += `
            <tr>
                <td style="font-weight:700;">${c.name}</td>
                <td style="font-family: 'Inter', sans-serif;">${c.id}</td>
                <td>${c.odoo_email}</td>
                <td>${c.phone}</td>
                <td style="color: ${c.registered_email.includes('@') ? 'var(--color-success)' : 'var(--text-muted)'}; font-weight: bold;">
                    ${c.registered_email}
                </td>
                <td style="font-family: 'Inter', sans-serif; font-weight: bold; text-align: center;">${c.po_count}</td>
            </tr>
        `;
    });
    tbody.innerHTML = tbodyHTML;
}

// ─── DETAILS MODAL DRAWER POPULATION ───────────────────────────────────────

window.openDetailsModal = function(orderId) {
    const o = state.orders.find(x => x.id === orderId);
    if (!o) return;

    const modalContent = document.getElementById("modal-body-content");
    const driveHTML = o.vendor_reference 
        ? `<a href="${o.vendor_reference}" target="_blank" class="drive-btn" style="font-size: 1.1rem;"><i class="fa-brands fa-google-drive"></i> فتح مستند الفاتورة (Google Drive)</a>`
        : `<span class="drive-btn-disabled" style="font-size: 1.1rem;"><i class="fa-solid fa-link-slash"></i> لا يوجد رابط Google Drive مرفق</span>`;

    // Milestones Terms Table
    let milestonesHTML = `
        <div class="mt-4">
            <h4 class="mb-3"><i class="fa-solid fa-list-ol text-primary"></i> بنود وشروط الدفع المتعاقد عليها (المقايسة)</h4>
            <div class="table-responsive">
                <table class="payments-table">
                    <thead>
                        <tr>
                            <th>البند</th>
                            <th>النوع</th>
                            <th>النسبة</th>
                            <th>القيمة المستحقة</th>
                            <th>شروط الدفعة / الملاحظات</th>
                        </tr>
                    </thead>
                    <tbody>
    `;

    if (o.milestones && o.milestones.length > 0) {
        o.milestones.sort((a,b) => a.payment_number - b.payment_number).forEach(m => {
            const pct = (m.input_val * 100).toFixed(0) + '%';
            const val = formatNumber(m.output_val) + ' د.ل';
            const typeStr = m.payment_type === 'bank' ? 'تحويل بنكي' : m.payment_type === 'cash' ? 'كاش' : m.payment_type === 'bond' ? 'صك' : 'غير محدد';
            milestonesHTML += `
                <tr>
                    <td style="font-weight: bold; text-align:center;">#${m.payment_number}</td>
                    <td>${m.payment === 'percentage' ? 'نسبة مئوية' : 'قيمة ثابتة'} (${typeStr})</td>
                    <td style="font-family: 'Inter';">${pct}</td>
                    <td style="font-family: 'Inter'; font-weight:bold;">${val}</td>
                    <td style="font-size:0.8rem; color:var(--text-secondary);">${m.payment_term || m.notes || '-'}</td>
                </tr>
            `;
        });
    } else {
        milestonesHTML += `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">لا توجد بنود دفع معرفة لأمر العمل هذا.</td></tr>`;
    }
    milestonesHTML += `</tbody></table></div></div>`;

    // Approvals (Payment Orders Issued) Table
    let approvalsHTML = `
        <div class="mt-4">
            <h4 class="mb-3"><i class="fa-solid fa-credit-card text-success"></i> أوامر الدفع الصادرة (أوامر السداد بالمالية)</h4>
            <div class="table-responsive">
                <table class="payments-table">
                    <thead>
                        <tr>
                            <th>رقم السداد</th>
                            <th>الحالة بالمالية</th>
                            <th>تاريخ الحركة</th>
                            <th>المدفوع الفعلي</th>
                        </tr>
                    </thead>
                    <tbody>
    `;

    if (o.approvals && o.approvals.length > 0) {
        o.approvals.forEach(app => {
            let statusBadgeClass = 'state-draft';
            let statusText = 'قيد التجهيز';
            
            if (app.request_status === 'cancel') {
                statusBadgeClass = 'state-cancel';
                statusText = 'ملغي';
            } else if (app.is_paid) {
                statusBadgeClass = 'state-approved';
                statusText = 'تم سداده ودفع بالكامل';
            } else {
                statusBadgeClass = 'state-confirm';
                statusText = 'تحت الإجراء بالمالية';
            }

            const dateStr = app.payment_date || (app.date_confirmed ? app.date_confirmed.split(' ')[0] : '-');
            approvalsHTML += `
                <tr>
                    <td style="font-weight: bold; font-family:'Inter'; font-size:1rem;">#${app.name}</td>
                    <td><span class="state-badge ${statusBadgeClass}">${statusText}</span></td>
                    <td style="font-family:'Inter';">${dateStr}</td>
                    <td style="font-family:'Inter'; font-weight:bold; color:var(--color-success);">${formatNumber(app.total_paid)} د.ل</td>
                </tr>
            `;
        });
    } else {
        approvalsHTML += `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">لا توجد أي أوامر سداد صادرة على أمر العمل هذا بعد.</td></tr>`;
    }
    approvalsHTML += `</tbody></table></div></div>`;


    // Construct whole modal content
    modalContent.innerHTML = `
        <div class="modal-info-grid">
            <div class="modal-info-item">
                <span>رقم أمر العمل</span>
                <p>${o.po_number}</p>
            </div>
            <div class="modal-info-item">
                <span>المقاول / المتعهد</span>
                <p>${o.contractor_name}</p>
            </div>
            <div class="modal-info-item">
                <span>موقع التنفيذ</span>
                <p>${o.location}</p>
            </div>
            <div class="modal-info-item">
                <span>مركز التكلفة</span>
                <p>${o.cost_center}</p>
            </div>
            <div class="modal-info-item">
                <span>رقم الفاتورة المعتمدة</span>
                <p>${o.invoice_no}</p>
            </div>
            <div class="modal-info-item">
                <span>تاريخ أمر العمل</span>
                <p>${o.date}</p>
            </div>
        </div>

        <div class="modal-info-grid" style="background: rgba(255,255,255,0.02); padding: 15px; border-radius: 12px; margin-bottom: 24px; border: 1px solid var(--border-color);">
            <div class="modal-info-item" style="border:none; background:none;">
                <span>القيمة الإجمالية لأمر العمل</span>
                <h3 class="amount-display text-primary">${formatNumber(o.total_amount)} د.ل</h3>
            </div>
            <div class="modal-info-item" style="border:none; background:none;">
                <span>القيمة المدفوعة فعلياً</span>
                <h3 class="amount-display text-success">${formatNumber(o.paid_amount)} د.ل</h3>
            </div>
            <div class="modal-info-item" style="border:none; background:none;">
                <span>تحت الإجراء لدى الإدارة المالية</span>
                <h3 class="amount-display text-warning">${formatNumber(o.under_process_amount)} د.ل</h3>
            </div>
            <div class="modal-info-item" style="border:none; background:none;">
                <span>القيمة المتبقية</span>
                <h3 class="amount-display text-danger">${formatNumber(o.remaining_amount)} د.ل</h3>
            </div>
        </div>

        <div style="margin-bottom: 24px;">
            ${driveHTML}
        </div>

        ${milestonesHTML}
        
        ${approvalsHTML}
    `;

    document.getElementById("details-modal").classList.remove("hidden");
};

// ─── EVENT LISTENERS & NAVIGATION ──────────────────────────────────────────

function setupEventListeners() {
    // Login Submit
    const loginForm = document.getElementById("login-form");
    if (loginForm) {
        loginForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const email = document.getElementById("email").value.trim();
            const password = document.getElementById("password").value.trim();
            const errorBox = document.getElementById("auth-error");

            errorBox.classList.add("hidden");

            try {
                const res = await fetch(`${API_BASE}/api/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                
                const data = await res.json();
                
                if (res.status === 200) {
                    localStorage.setItem("meraas_user", JSON.stringify(data));
                    localStorage.setItem("meraas_token", data.token);
                    state.user = data;
                    state.token = data.token;
                    showMainApp();
                } else {
                    errorBox.textContent = data.error || "فشل تسجيل الدخول";
                    errorBox.classList.remove("hidden");
                }
            } catch (err) {
                errorBox.textContent = "حدث خطأ في الاتصال بالخادم.";
                errorBox.classList.remove("hidden");
            }
        });
    }

    // Register (Setup password) Submit
    const registerForm = document.getElementById("register-form");
    if (registerForm) {
        registerForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const email = document.getElementById("reg-email").value.trim();
            const password = document.getElementById("reg-password").value.trim();
            const errorBox = document.getElementById("register-error");
            const successBox = document.getElementById("register-success");

            errorBox.classList.add("hidden");
            successBox.classList.add("hidden");

            try {
                const res = await fetch(`${API_BASE}/api/setup-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                
                const data = await res.json();
                
                if (res.status === 200) {
                    successBox.textContent = "تم إنشاء الحساب بنجاح! جاري تحويلك للمنظومة...";
                    successBox.classList.remove("hidden");
                    
                    localStorage.setItem("meraas_user", JSON.stringify(data));
                    localStorage.setItem("meraas_token", data.token);
                    state.user = data;
                    state.token = data.token;
                    
                    setTimeout(() => {
                        showMainApp();
                    }, 1500);
                } else {
                    errorBox.textContent = data.error || "فشل إنشاء الحساب";
                    errorBox.classList.remove("hidden");
                }
            } catch (err) {
                errorBox.textContent = "حدث خطأ في الاتصال بالسيرفر.";
                errorBox.classList.remove("hidden");
            }
        });
    }

    // Auth toggle screen buttons
    document.getElementById("toggle-register").addEventListener("click", (e) => {
        e.preventDefault();
        showRegisterScreen();
    });

    document.getElementById("toggle-login").addEventListener("click", (e) => {
        e.preventDefault();
        showLoginScreen();
    });

    // Refresh Odoo data button
    document.getElementById("refresh-data").addEventListener("click", () => {
        // Simple spin animation on refresh click
        const icon = document.querySelector("#refresh-data i");
        icon.classList.add("fa-spin");
        refreshData().then(() => {
            setTimeout(() => icon.classList.remove("fa-spin"), 600);
        });
    });

    // Admin selector change event
    const adminSelect = document.getElementById("admin-contractor-select");
    if (adminSelect) {
        adminSelect.addEventListener("change", (e) => {
            state.selectedPartnerId = e.target.value;
            refreshData();
        });
    }

    // Logout button
    document.getElementById("logout-button").addEventListener("click", (e) => {
        e.preventDefault();
        handleLogout();
    });

    // Sidebar navigation tabs switching
    document.querySelectorAll(".menu-item[data-tab]").forEach(item => {
        item.addEventListener("click", (e) => {
            e.preventDefault();
            const tabName = item.getAttribute("data-tab");
            
            // Toggle active classes in menu
            document.querySelectorAll(".menu-item").forEach(i => i.classList.remove("active"));
            item.classList.add("active");

            // Toggle active content section
            document.querySelectorAll(".tab-content").forEach(c => c.classList.add("hidden"));
            document.getElementById(`tab-${tabName}`).classList.remove("hidden");

            // Update top nav title
            const titles = {
                'dashboard': 'لوحة المتابعة',
                'work-orders': 'أوامر العمل والمستحقات الماليّة',
                'admin-panel': 'بوابة ربط وإدارة المتعهدين'
            };
            document.getElementById("page-title").textContent = titles[tabName] || 'ميراس';
            state.activeTab = tabName;
        });
    });

    // Quick filter navigation tabs under Work Orders
    document.querySelectorAll(".quick-tabs .tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".quick-tabs .tab-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            state.quickFilter = btn.getAttribute("data-filter");
            applyFiltersAndRender();
        });
    });

    // Search filter input
    document.getElementById("search-box").addEventListener("input", (e) => {
        state.searchQuery = e.target.value.trim();
        applyFiltersAndRender();
    });

    // Dropdown filters (Status, Project/Location, Cost Center)
    document.getElementById("filter-status").addEventListener("change", (e) => {
        state.statusFilter = e.target.value;
        applyFiltersAndRender();
    });

    document.getElementById("filter-project").addEventListener("change", (e) => {
        state.projectFilter = e.target.value;
        applyFiltersAndRender();
    });

    document.getElementById("filter-cost-center").addEventListener("change", (e) => {
        state.costCenterFilter = e.target.value;
        applyFiltersAndRender();
    });

    document.getElementById("sort-order").addEventListener("change", (e) => {
        state.sortOrder = e.target.value;
        applyFiltersAndRender();
    });

    // Close details modal
    document.getElementById("close-modal").addEventListener("click", () => {
        document.getElementById("details-modal").classList.add("hidden");
    });

    // Close modal on clicking overlay background
    document.getElementById("details-modal").addEventListener("click", (e) => {
        if (e.target.id === "details-modal") {
            document.getElementById("details-modal").classList.add("hidden");
        }
    });

    // Admin map contractor form submit
    const adminMapForm = document.getElementById("admin-map-form");
    if (adminMapForm) {
        adminMapForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const partner_id = document.getElementById("map-partner").value;
            const email = document.getElementById("map-email").value.trim().toLowerCase();
            const password = document.getElementById("map-password").value.trim();

            if (!partner_id || !email) return;

            try {
                const res = await fetch(`${API_BASE}/api/contractors/map`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${state.token}`
                    },
                    body: JSON.stringify({ partner_id, email, password })
                });
                
                const data = await res.json();
                if (data.success) {
                    alert(`تم ربط المتعهد ببريد ${email} بنجاح!`);
                    adminMapForm.reset();
                    document.getElementById("map-password").value = "123456";
                    refreshData();
                } else {
                    alert(`خطأ: ${data.error}`);
                }
            } catch (err) {
                alert("حدث خطأ في شبكة الاتصال.");
            }
        });
    }
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

function formatNumber(num) {
    if (num === null || num === undefined) return "0.00";
    return Number(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCurrency(num) {
    return `${formatNumber(num)} د.ل`;
}

function getStateClass(stateStr) {
    if (stateStr === 'مسودة' || stateStr === 'draft') return 'state-draft';
    if (stateStr === 'مؤكد' || stateStr === 'confirm') return 'state-confirm';
    if (stateStr === 'معتمد' || stateStr === 'approved' || stateStr === 'done') return 'state-approved';
    if (stateStr === 'ملغي' || stateStr === 'cancel') return 'state-cancel';
    return 'state-draft';
}

// Dynamic loading spinner/overlay
function showLoader() {
    let loader = document.getElementById("app-global-loader");
    if (!loader) {
        loader = document.createElement("div");
        loader.id = "app-global-loader";
        loader.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(10, 13, 22, 0.85);
            z-index: 9999;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 20px;
            backdrop-filter: blur(8px);
        `;
        loader.innerHTML = `
            <div class="loader-spinner" style="
                width: 50px;
                height: 50px;
                border: 4px solid rgba(255,255,255,0.05);
                border-top: 4px solid var(--color-primary);
                border-radius: 50%;
                animation: spin 1s linear infinite;
            "></div>
            <div style="font-weight: 700; color: white;">جاري مزامنة وجلب البيانات من نظام Odoo...</div>
        `;
        
        // Add style keyframe dynamically
        if (!document.getElementById("loader-keyframes")) {
            const style = document.createElement("style");
            style.id = "loader-keyframes";
            style.innerHTML = `@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`;
            document.head.appendChild(style);
        }
        
        document.body.appendChild(loader);
    }
    loader.classList.remove("hidden");
}

function hideLoader() {
    const loader = document.getElementById("app-global-loader");
    if (loader) {
        loader.classList.add("hidden");
    }
}

// Resizable Columns Functionality
function initResizableColumns(table) {
    const cols = table.querySelectorAll("th");
    cols.forEach(col => {
        // Create resize handle
        const handle = document.createElement("div");
        handle.classList.add("resize-handle");
        col.appendChild(handle);

        let startX, startWidth;

        handle.addEventListener("mousedown", e => {
            e.preventDefault();
            startX = e.clientX;
            startWidth = col.offsetWidth;
            handle.classList.add("resizing");

            const onMouseMove = ev => {
                const isRTL = document.documentElement.dir === "rtl" || document.body.dir === "rtl" || window.getComputedStyle(table).direction === "rtl";
                const diff = ev.clientX - startX;
                const widthChange = isRTL ? -diff : diff;
                
                const newWidth = Math.max(30, startWidth + widthChange);
                col.style.width = `${newWidth}px`;
                col.style.minWidth = `${newWidth}px`;
            };

            const onMouseUp = () => {
                handle.classList.remove("resizing");
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
            };

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });
    });
}
