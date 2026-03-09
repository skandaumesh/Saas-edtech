// ============================================================================
// STUDENT MANAGEMENT SYSTEM - FULLY UPDATED VERSION
// ============================================================================
const API_BASE_URL = window.APP_CONFIG.API_BASE_URL;
console.log('🔧 Students API Base URL:', API_BASE_URL);
// GLOBAL VARIABLES
let allStudents = [];
let filteredStudents = [];
let selectedStudents = new Set();
let currentSortColumn = null;
let currentSortDirection = 'asc';
let searchTimeout = null;

// Dynamic data from database
let availableStreams = [];
let availableSemesters = [];
let availableLanguages = [];
let availableElectives = [];
let filteredLanguages = [];
let filteredElectives = [];

// ============================================================================
// FILTER PERSISTENCE (sessionStorage)
// ============================================================================

function saveFiltersToStorage() {
    const filters = {
        stream: document.getElementById('streamFilter')?.value || '',
        semester: document.getElementById('semesterFilter')?.value || '',
        language: document.getElementById('languageFilter')?.value || '',
        status: document.getElementById('statusFilter')?.value || '',
        elective: document.getElementById('electiveFilter')?.value || '',
        search: document.getElementById('searchInput')?.value || ''
    };
    sessionStorage.setItem('studentFilters', JSON.stringify(filters));
    console.log('💾 Filters saved:', filters);
}

function restoreFiltersFromStorage() {
    const saved = sessionStorage.getItem('studentFilters');
    if (!saved) return null;
    try {
        return JSON.parse(saved);
    } catch (e) {
        return null;
    }
}

function applyStoredFilters() {
    const filters = restoreFiltersFromStorage();
    if (!filters) return;

    console.log('📂 Restoring filters:', filters);

    if (filters.stream && document.getElementById('streamFilter')) {
        document.getElementById('streamFilter').value = filters.stream;
        // Update dependent filters
        filterLanguagesByStreamSem(filters.stream, filters.semester || '');
        filterElectivesByStreamSem(filters.stream, filters.semester || '');
        updateLanguageFilter();
        updateElectiveFilter();
    }
    if (filters.semester && document.getElementById('semesterFilter')) {
        document.getElementById('semesterFilter').value = filters.semester;
    }
    if (filters.language && document.getElementById('languageFilter')) {
        document.getElementById('languageFilter').value = filters.language;
    }
    if (filters.status && document.getElementById('statusFilter')) {
        document.getElementById('statusFilter').value = filters.status;
    }
    if (filters.elective && document.getElementById('electiveFilter')) {
        document.getElementById('electiveFilter').value = filters.elective;
    }
    if (filters.search && document.getElementById('searchInput')) {
        document.getElementById('searchInput').value = filters.search;
    }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 Student Management System initialized');
    await loadAllStudents();
    addNotificationStyles();
});

// ============================================================================
// NOTIFICATION SYSTEM
// ============================================================================

function addNotificationStyles() {
    if (document.getElementById('notification-styles')) return;

    const style = document.createElement('style');
    style.id = 'notification-styles';
    style.textContent = `
        .notification-toast {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%) scale(0.8);
            z-index: 100000;
            opacity: 0;
            transition: all 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55);
            pointer-events: none;
        }
        
        .notification-toast.show {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
        }
        
        .notification-content {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 12px 20px;
            background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
            color: white;
            border-radius: 10px;
            box-shadow: 0 8px 28px rgba(34, 197, 94, 0.4), 0 3px 10px rgba(0, 0, 0, 0.12);
            font-size: 14px;
            font-weight: 600;
            min-width: 280px;
            max-width: 450px;
        }
        
        .notification-icon {
            font-size: 22px;
            animation: iconPop 0.5s ease;
        }
        
        .notification-message {
            flex: 1;
            letter-spacing: 0.2px;
        }
        
        @keyframes iconPop {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.15); }
        }
    `;
    document.head.appendChild(style);
}

let notificationTimeout = null;

function showNotification(message, type = 'success') {
    if (notificationTimeout) {
        clearTimeout(notificationTimeout);
        notificationTimeout = null;
    }

    document.querySelectorAll('.notification-toast').forEach(n => n.remove());

    const notification = document.createElement('div');
    notification.className = 'notification-toast';

    const icons = {
        success: 'check_circle',
        error: 'info',
        warning: 'info',
        info: 'info'
    };

    notification.innerHTML = `
        <div class="notification-content">
            <i class="material-icons-round notification-icon">${icons[type] || 'info'}</i>
            <span class="notification-message">${message}</span>
        </div>
    `;

    document.body.appendChild(notification);

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            notification.classList.add('show');
        });
    });

    notificationTimeout = setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            notification.remove();
            notificationTimeout = null;
        }, 300);
    }, 2500);
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadAllStudents() {
    showLoading(true);

    try {
        console.log('📡 Fetching fresh data from database...');

        const timestamp = new Date().getTime();
        const response = await fetch(`${API_BASE_URL}/students/all?t=${timestamp}`, {
            method: 'GET',
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('📦 Fresh data received:', data);

        if (data.success) {
            allStudents = data.students || [];
            // Sort by studentID
            allStudents.sort((a, b) => (a.studentID || '').localeCompare(b.studentID || ''));
            filteredStudents = [...allStudents];

            await extractDynamicData();

            console.log(`✅ Loaded ${allStudents.length} students (fresh from DB)`);

            if (allStudents.length === 0) {
                showEmptyState('No students found', 'Database is empty. Add students to get started.');
            } else {
                updateAllStats();
                populateDynamicFilters();
                // Restore saved filters and apply them
                applyStoredFilters();
                applyFilters();
            }
        } else {
            throw new Error(data.error || 'Failed to load students');
        }
    } catch (error) {
        console.error('❌ Error loading students:', error);
        showNotification('Error: ' + error.message, 'error');
        showEmptyState('Error loading students', error.message);
    } finally {
        showLoading(false);
    }
}

async function extractDynamicData() {
    // Fetch streams
    try {
        const timestamp = new Date().getTime();
        const streamsResponse = await fetch(`${API_BASE_URL}/students/streams?t=${timestamp}`, {
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache'
            }
        });

        const streamsData = await streamsResponse.json();

        if (streamsData.success && Array.isArray(streamsData.streams)) {
            availableStreams = streamsData.streams.filter(Boolean).sort();
        } else if (Array.isArray(streamsData)) {
            availableStreams = streamsData.filter(Boolean).sort();
        } else {
            throw new Error('Invalid streams response format');
        }
    } catch (error) {
        console.error('❌ Error fetching streams:', error);
        availableStreams = [...new Set(allStudents.map(s => s.stream).filter(Boolean))].sort();
    }

    // Semesters
    availableSemesters = [1, 2, 3, 4, 5, 6];

    // Fetch languages
    try {
        const timestamp = new Date().getTime();
        const languagesResponse = await fetch(`${API_BASE_URL}/subjects/languages?t=${timestamp}`, {
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache'
            }
        });

        const languagesData = await languagesResponse.json();

        if (languagesData.success && languagesData.subjects) {
            const languageSet = new Set();

            languagesData.subjects.forEach(s => {
                let lang = s.languageType || s.name;
                if (lang) {
                    lang = lang.trim().toUpperCase();
                    if (lang === 'ENGLISH') return;
                    languageSet.add(lang);
                }
            });

            availableLanguages = Array.from(languageSet).sort();
        } else {
            throw new Error('Invalid languages response format');
        }
    } catch (error) {
        console.error('❌ Error fetching languages:', error);
        availableLanguages = ['ADDITIONAL ENGLISH', 'HINDI', 'KANNADA', 'SANSKRIT', 'TAMIL'].sort();
    }

    // Fetch electives
    try {
        const timestamp = new Date().getTime();
        const electivesResponse = await fetch(`${API_BASE_URL}/students/subjects/electives?t=${timestamp}`, {
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache'
            }
        });

        const electivesData = await electivesResponse.json();

        if (electivesData.success && electivesData.subjects) {
            const electiveSet = new Set();

            electivesData.subjects.forEach(s => {
                if (s.name) {
                    electiveSet.add(s.name.trim().toUpperCase());
                }
            });

            availableElectives = Array.from(electiveSet).sort();
        } else {
            throw new Error('Invalid electives response format');
        }
    } catch (error) {
        console.error('❌ Error fetching electives:', error);
        const electives = new Set();
        allStudents.forEach(student => {
            if (student.electiveSubject) electives.add(student.electiveSubject.trim().toUpperCase());
            if (student.elective1) electives.add(student.elective1.trim().toUpperCase());
            if (student.elective2) electives.add(student.elective2.trim().toUpperCase());
        });
        availableElectives = Array.from(electives).sort();
    }

    console.log('📊 ============ EXTRACTED DATA ============');
    console.log('📚 Streams:', availableStreams);
    console.log('🗣️ Languages:', availableLanguages);
    console.log('📖 Electives:', availableElectives);
}

function filterLanguagesByStreamSem(stream, semester) {
    if (!stream || !semester) {
        filteredLanguages = [...availableLanguages];
        return;
    }

    const studentsInStreamSem = allStudents.filter(s =>
        s.stream === stream && s.semester === parseInt(semester)
    );

    const languageSet = new Set();
    studentsInStreamSem.forEach(student => {
        if (student.languageSubject) {
            const lang = student.languageSubject.trim().toUpperCase();
            if (lang !== 'ENGLISH') {
                languageSet.add(lang);
            }
        }
    });

    filteredLanguages = Array.from(languageSet).sort();
}

function filterElectivesByStreamSem(stream, semester) {
    if (!stream || !semester) {
        filteredElectives = [...availableElectives];
        return;
    }

    const studentsInStreamSem = allStudents.filter(s =>
        s.stream === stream && s.semester === parseInt(semester)
    );

    const electiveSet = new Set();
    studentsInStreamSem.forEach(student => {
        if (student.electiveSubject) {
            electiveSet.add(student.electiveSubject.trim().toUpperCase());
        }
        if (student.elective1) {
            electiveSet.add(student.elective1.trim().toUpperCase());
        }
        if (student.elective2) {
            electiveSet.add(student.elective2.trim().toUpperCase());
        }
    });

    filteredElectives = Array.from(electiveSet).sort();
}

function populateDynamicFilters() {
    const streamFilter = document.getElementById('streamFilter');
    const semesterFilter = document.getElementById('semesterFilter');

    if (streamFilter) {
        streamFilter.innerHTML = '<option value="">All Streams</option>';
        availableStreams.forEach(stream => {
            const option = document.createElement('option');
            option.value = stream;
            option.textContent = stream;
            streamFilter.appendChild(option);
        });
    }

    if (semesterFilter) {
        semesterFilter.innerHTML = '<option value="">All Semesters</option>';
        availableSemesters.forEach(sem => {
            const option = document.createElement('option');
            option.value = sem;
            option.textContent = `Semester ${sem}`;
            semesterFilter.appendChild(option);
        });
    }

    updateLanguageFilter();
    updateElectiveFilter();

    if (streamFilter) {
        streamFilter.addEventListener('change', () => {
            const stream = streamFilter.value;
            const semester = semesterFilter ? semesterFilter.value : '';
            filterLanguagesByStreamSem(stream, semester);
            filterElectivesByStreamSem(stream, semester);
            updateLanguageFilter();
            updateElectiveFilter();
            applyFilters();
        });
    }

    if (semesterFilter) {
        semesterFilter.addEventListener('change', () => {
            const stream = streamFilter ? streamFilter.value : '';
            const semester = semesterFilter.value;
            filterLanguagesByStreamSem(stream, semester);
            filterElectivesByStreamSem(stream, semester);
            updateLanguageFilter();
            updateElectiveFilter();
            applyFilters();
        });
    }
}

function updateLanguageFilter() {
    const languageFilter = document.getElementById('languageFilter');
    if (!languageFilter) return;

    const currentValue = languageFilter.value;
    languageFilter.innerHTML = '<option value="">All Languages</option>';

    const languagesToShow = filteredLanguages.length > 0 ? filteredLanguages : availableLanguages;

    languagesToShow.forEach(lang => {
        const option = document.createElement('option');
        option.value = lang;
        option.textContent = lang;
        languageFilter.appendChild(option);
    });

    if (currentValue && languagesToShow.includes(currentValue)) {
        languageFilter.value = currentValue;
    }
}

function updateElectiveFilter() {
    const electiveFilter = document.getElementById('electiveFilter');
    if (!electiveFilter) return;

    const currentValue = electiveFilter.value;
    electiveFilter.innerHTML = '<option value="">All Electives</option>';

    const electivesToShow = filteredElectives.length > 0 ? filteredElectives : availableElectives;

    electivesToShow.forEach(elective => {
        const option = document.createElement('option');
        option.value = elective;
        option.textContent = elective;
        electiveFilter.appendChild(option);
    });

    if (currentValue && electivesToShow.includes(currentValue)) {
        electiveFilter.value = currentValue;
    }
}

// ============================================================================
// FILTERING & SEARCH
// ============================================================================

function applyFilters() {
    const streamFilter = document.getElementById('streamFilter');
    const semesterFilter = document.getElementById('semesterFilter');
    const languageFilter = document.getElementById('languageFilter');
    const statusFilter = document.getElementById('statusFilter');
    const electiveFilter = document.getElementById('electiveFilter');
    const searchInput = document.getElementById('searchInput');

    const stream = streamFilter ? streamFilter.value : '';
    const semester = semesterFilter ? semesterFilter.value : '';
    const language = languageFilter ? languageFilter.value : '';
    const status = statusFilter ? statusFilter.value : '';
    const elective = electiveFilter ? electiveFilter.value : '';
    const search = searchInput ? searchInput.value.toLowerCase() : '';

    filteredStudents = allStudents.filter(student => {
        if (stream && student.stream !== stream) return false;
        if (semester && student.semester?.toString() !== semester) return false;
        if (language && student.languageSubject !== language) return false;

        if (status !== '') {
            const isActive = status === 'true';
            if (student.isActive !== isActive) return false;
        }

        if (elective && student.electiveSubject !== elective && student.elective1 !== elective && student.elective2 !== elective) return false;

        if (search) {
            const searchFields = [
                student.studentID,
                student.name,
                student.parentPhone,
                student.stream,
                student.languageSubject,
                student.electiveSubject
            ].filter(Boolean).map(f => f.toString().toLowerCase());

            if (!searchFields.some(field => field.includes(search))) return false;
        }

        return true;
    });

    // Sort by studentID
    filteredStudents.sort((a, b) => (a.studentID || '').localeCompare(b.studentID || ''));

    console.log(`🔍 Filtered: ${filteredStudents.length}/${allStudents.length}`);

    // Save filters to sessionStorage
    saveFiltersToStorage();

    updateAllStats();
    renderTable();
}

function debounceSearch() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        applyFilters();
    }, 300);
}

// ============================================================================
// TABLE RENDERING
// ============================================================================

function renderTable() {
    const tbody = document.getElementById('studentTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (filteredStudents.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="11" style="text-align: center; padding: 3rem; color: #6b7280;">
                    <i class="material-icons-round" style="font-size: 3rem; margin-bottom: 1rem; display: block; opacity: 0.5;">search_off</i>
                    <div style="font-size: 1.125rem; font-weight: 600;">No students found</div>
                    <div style="font-size: 0.875rem; margin-top: 0.5rem;">Try adjusting your filters</div>
                </td>
            </tr>
        `;
        return;
    }

    filteredStudents.forEach((student, index) => {
        const row = document.createElement('tr');

        const studentId = student._id?.toString() || student._id;
        row.setAttribute('data-student-id', studentId);

        const isSelected = selectedStudents.has(studentId);
        if (isSelected) row.classList.add('selected');

        row.innerHTML = `
            <td style="text-align: center; width: 40px;">
                <input 
                    type="checkbox" 
                    class="student-checkbox" 
                    ${isSelected ? 'checked' : ''}
                    data-id="${studentId}"
                    onchange="toggleStudentSelection('${studentId}')"
                >
            </td>
            <td style="text-align: center; width: 50px; font-weight: 600; color: #6b7280;">
                ${index + 1}
            </td>
            <td class="editable" data-field="studentID" data-id="${studentId}">
                ${student.studentID || '-'}
            </td>
            <td class="editable" data-field="name" data-id="${studentId}" style="font-weight: 500;">
                ${student.name || '-'}
            </td>
            <td class="editable" data-field="stream" data-id="${studentId}">
                <span class="stream-badge">
                    ${student.stream || '-'}
                </span>
            </td>
            <td class="editable" data-field="semester" data-id="${studentId}" style="text-align: center;">
                <span class="semester-badge">
                    SEM ${student.semester || '-'}
                </span>
            </td>
            <td class="editable" data-field="languageSubject" data-id="${studentId}">
                ${student.languageSubject ?
                `<span class="language-badge">${student.languageSubject}</span>` :
                '<span style="color: #9ca3af;">-</span>'}
            </td>
            <td class="editable" data-field="electiveSubject" data-id="${studentId}">
                ${student.electiveSubject ?
                `<span class="elective-badge">${student.electiveSubject}</span>` :
                '<span style="color: #9ca3af;">-</span>'}
            </td>
            <td class="editable" data-field="parentPhone" data-id="${studentId}">
                ${student.parentPhone || '-'}
            </td>
            <td style="text-align: center;">
                <span class="status-badge ${student.isActive !== false ? 'status-active' : 'status-inactive'}">
                    <i class="material-icons-round" style="font-size: 14px;">
                        ${student.isActive !== false ? 'check_circle' : 'cancel'}
                    </i>
                    ${student.isActive !== false ? 'ACTIVE' : 'INACTIVE'}
                </span>
            </td>
            <td style="text-align: center; width: 80px;">
                <button class="action-btn btn-delete" onclick="deleteStudent('${studentId}')" title="Delete">
                    <i class="material-icons-round" style="font-size: 16px;">delete</i>
                </button>
            </td>
        `;

        tbody.appendChild(row);
    });

    attachInlineEditListeners();
    updateSelectAllCheckbox();

    console.log(`📋 Rendered ${filteredStudents.length} students`);
}

// ============================================================================
// INLINE EDITING
// ============================================================================

function attachInlineEditListeners() {
    document.querySelectorAll('.editable').forEach(cell => {
        cell.addEventListener('dblclick', function () {
            if (cell.querySelector('input, select')) return;

            const studentId = this.getAttribute('data-id');
            const field = this.getAttribute('data-field');
            const student = allStudents.find(s => (s._id?.toString() || s._id) === studentId);

            if (!student) return;

            const currentValue = student[field] || '';
            const originalHTML = this.innerHTML;

            let inputHTML = '';

            if (field === 'stream') {
                inputHTML = `
                    <select class="inline-edit-input" style="width: 100%; padding: 6px; border: 2px solid #6366f1; border-radius: 4px; font-size: 14px;">
                        ${availableStreams.map(stream =>
                    `<option value="${stream}" ${currentValue === stream ? 'selected' : ''}>${stream}</option>`
                ).join('')}
                    </select>
                `;
            } else if (field === 'semester') {
                inputHTML = `
                    <select class="inline-edit-input" style="width: 100%; padding: 6px; border: 2px solid #6366f1; border-radius: 4px; font-size: 14px;">
                        ${availableSemesters.map(sem =>
                    `<option value="${sem}" ${currentValue == sem ? 'selected' : ''}>Semester ${sem}</option>`
                ).join('')}
                    </select>
                `;
            } else if (field === 'languageSubject') {
                inputHTML = `
                    <select class="inline-edit-input" style="width: 100%; padding: 6px; border: 2px solid #6366f1; border-radius: 4px; font-size: 14px;">
                        <option value="">None</option>
                        ${availableLanguages.map(lang =>
                    `<option value="${lang}" ${currentValue === lang ? 'selected' : ''}>${lang}</option>`
                ).join('')}
                    </select>
                `;
            } else if (field === 'electiveSubject') {
                inputHTML = `
                    <select class="inline-edit-input" style="width: 100%; padding: 6px; border: 2px solid #6366f1; border-radius: 4px; font-size: 14px;">
                        <option value="">None</option>
                        ${availableElectives.map(elective =>
                    `<option value="${elective}" ${currentValue === elective ? 'selected' : ''}>${elective}</option>`
                ).join('')}
                    </select>
                `;
            } else {
                inputHTML = `
                    <input 
                        type="text" 
                        class="inline-edit-input" 
                        value="${currentValue}" 
                        style="width: 100%; padding: 6px; border: 2px solid #6366f1; border-radius: 4px; font-size: 14px; outline: none;"
                    >
                `;
            }

            this.innerHTML = inputHTML;
            const input = this.querySelector('.inline-edit-input');
            input.focus();
            if (input.select) input.select();

            const saveEdit = async () => {
                const newValue = input.value;

                if (newValue === currentValue) {
                    this.innerHTML = originalHTML;
                    return;
                }

                try {
                    const updateData = { [field]: newValue };

                    const response = await fetch(`${API_BASE_URL}/students/${studentId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(updateData)
                    });

                    const data = await response.json();

                    if (data.success) {
                        student[field] = newValue;
                        showNotification('✅ Updated successfully', 'success');
                        await loadAllStudents();
                    } else {
                        this.innerHTML = originalHTML;
                        showNotification('❌ Error: ' + data.error, 'error');
                    }
                } catch (error) {
                    this.innerHTML = originalHTML;
                    showNotification('❌ Error updating field', 'error');
                }
            };

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    saveEdit();
                } else if (e.key === 'Escape') {
                    this.innerHTML = originalHTML;
                }
            });

            input.addEventListener('blur', saveEdit);
        });

        cell.addEventListener('mouseenter', function () {
            if (!this.querySelector('input, select')) {
                this.style.background = '#f3f4f6';
            }
        });

        cell.addEventListener('mouseleave', function () {
            if (!this.querySelector('input, select')) {
                this.style.background = '';
            }
        });
    });
}

// ============================================================================
// SELECTION MANAGEMENT
// ============================================================================

function toggleStudentSelection(studentId) {
    if (!studentId) return;

    if (selectedStudents.has(studentId)) {
        selectedStudents.delete(studentId);
    } else {
        selectedStudents.add(studentId);
    }

    updateBulkActionsBar();
    updateSelectAllCheckbox();

    const row = document.querySelector(`tr[data-student-id="${studentId}"]`);
    if (row) {
        row.classList.toggle('selected');
        const checkbox = row.querySelector('.student-checkbox');
        if (checkbox) {
            checkbox.checked = selectedStudents.has(studentId);
        }
    }
}

function toggleSelectAll() {
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');

    if (selectAllCheckbox?.checked) {
        filteredStudents.forEach(student => {
            const studentId = student._id?.toString() || student._id;
            selectedStudents.add(studentId);
        });
    } else {
        selectedStudents.clear();
    }

    updateBulkActionsBar();
    renderTable();
}

function updateSelectAllCheckbox() {
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');
    if (!selectAllCheckbox) return;

    const visibleIds = filteredStudents.map(s => s._id?.toString() || s._id);
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedStudents.has(id));

    selectAllCheckbox.checked = allSelected;
    selectAllCheckbox.indeterminate = !allSelected && visibleIds.some(id => selectedStudents.has(id));
}

function updateBulkActionsBar() {
    const bulkActionsBar = document.getElementById('bulkActionsBar');
    if (!bulkActionsBar) return;

    const selectedCountText = document.getElementById('selectedCountText');

    if (selectedStudents.size > 0) {
        bulkActionsBar.classList.add('active');
        if (selectedCountText) {
            selectedCountText.textContent = `${selectedStudents.size} student${selectedStudents.size > 1 ? 's' : ''} selected`;
        }
    } else {
        bulkActionsBar.classList.remove('active');
    }
}

function clearSelection() {
    selectedStudents.clear();
    updateBulkActionsBar();
    renderTable();
}

// ============================================================================
// STUDENT OPERATIONS
// ============================================================================

async function deleteStudent(studentId) {
    const student = allStudents.find(s => {
        const id = s._id?.toString() || s._id;
        return id === studentId;
    });

    if (!confirm(`Delete ${student?.name || 'this student'}?`)) return;

    try {
        showLoading(true);
        const response = await fetch(`${API_BASE_URL}/students/${studentId}`, { method: 'DELETE' });
        const data = await response.json();

        if (data.success) {
            showNotification('✅ Student deleted successfully', 'success');
            await loadAllStudents();
        } else {
            showNotification('❌ Error: ' + data.error, 'error');
        }
    } catch (error) {
        showNotification('❌ Error deleting student', 'error');
    } finally {
        showLoading(false);
    }
}

async function bulkDelete() {
    if (selectedStudents.size === 0) return;
    if (!confirm(`Delete ${selectedStudents.size} students?`)) return;

    try {
        showLoading(true);
        const promises = Array.from(selectedStudents).map(id =>
            fetch(`${API_BASE_URL}/students/${id}`, { method: 'DELETE' })
        );
        await Promise.all(promises);
        showNotification(`✅ ${selectedStudents.size} students deleted`, 'success');
        clearSelection();
        await loadAllStudents();
    } catch (error) {
        showNotification('❌ Error deleting students', 'error');
    } finally {
        showLoading(false);
    }
}

async function bulkUpdateStatus(isActive) {
    if (selectedStudents.size === 0) return;

    try {
        showLoading(true);
        const promises = Array.from(selectedStudents).map(id =>
            fetch(`${API_BASE_URL}/students/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isActive })
            })
        );
        await Promise.all(promises);
        showNotification(`✅ ${selectedStudents.size} students updated`, 'success');
        clearSelection();
        await loadAllStudents();
    } catch (error) {
        showNotification('❌ Error updating students', 'error');
    } finally {
        showLoading(false);
    }
}

function bulkExport() {
    if (selectedStudents.size === 0) return;
    const data = allStudents.filter(s => {
        const id = s._id?.toString() || s._id;
        return selectedStudents.has(id);
    });
    exportToCSV(data, 'selected_students.csv');
}

function exportData() {
    exportToCSV(filteredStudents, 'students_export.csv');
}

function exportToCSV(data, filename) {
    const headers = ['ID', 'Name', 'Stream', 'Sem', 'Lang', 'Elective', 'Phone', 'Status'];
    const rows = data.map(s => [
        s.studentID || '',
        s.name || '',
        s.stream || '',
        s.semester || '',
        s.languageSubject || '',
        s.electiveSubject || '',
        s.parentPhone || '',
        s.isActive !== false ? 'Active' : 'Inactive'
    ]);

    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    showNotification(`✅ Exported ${data.length} students`, 'success');
}

// ============================================================================
// ADD STUDENT MODAL - FIXED WITH ELECTIVES
// ============================================================================

function openAddModal() {
    console.log('🔵 Opening Add Student Modal');

    const form = document.getElementById('studentForm');
    if (form) form.reset();

    const title = document.getElementById('modalTitle');
    if (title) title.textContent = 'Add New Student';

    // Stream dropdown
    const streamSelect = document.getElementById('studentStream');
    if (streamSelect && availableStreams.length > 0) {
        streamSelect.innerHTML = '<option value="">Select Stream</option>';
        availableStreams.forEach(stream => {
            const option = document.createElement('option');
            option.value = stream;
            option.textContent = stream;
            streamSelect.appendChild(option);
        });
    }

    // Language dropdown
    const languageSelect = document.getElementById('studentLanguage');
    if (languageSelect && availableLanguages.length > 0) {
        languageSelect.innerHTML = '<option value="">Select Language</option>';
        availableLanguages.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang;
            option.textContent = lang;
            languageSelect.appendChild(option);
        });
    }

    // ✅ FIXED: Elective dropdown
    const electiveSelect = document.getElementById('studentElective');
    if (electiveSelect && availableElectives.length > 0) {
        electiveSelect.innerHTML = '<option value="">Select Elective</option>';
        availableElectives.forEach(elective => {
            const option = document.createElement('option');
            option.value = elective;
            option.textContent = elective;
            electiveSelect.appendChild(option);
        });
    }

    const modal = document.getElementById('studentModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('active');
    }
}

// ✅ FIXED: Unified closeModal function
function closeModal() {
    const modal = document.getElementById('studentModal');
    if (modal) {
        modal.classList.remove('active');
        setTimeout(() => modal.classList.add('hidden'), 300);

        const form = document.getElementById('studentForm');
        if (form) form.reset();
    }
}

async function saveStudent(event) {
    event.preventDefault();

    const studentID = document.getElementById('studentId')?.value?.trim();
    const name = document.getElementById('studentName')?.value?.trim();
    const stream = document.getElementById('studentStream')?.value;
    const semester = document.getElementById('studentSemester')?.value;
    const parentPhone = document.getElementById('studentPhone')?.value?.trim();
    const languageSubject = document.getElementById('studentLanguage')?.value;
    const electiveSubject = document.getElementById('studentElective')?.value?.trim();
    const isActive = document.getElementById('studentStatus')?.value === 'true';

    if (!studentID || !name || !stream || !semester) {
        showNotification('⚠️ Please fill all required fields', 'warning');
        return;
    }

    const studentData = {
        studentID, name, stream,
        semester: parseInt(semester),
        parentPhone, languageSubject, electiveSubject,
        isActive,
        academicYear: new Date().getFullYear()
    };

    try {
        showLoading(true);

        const response = await fetch(`${API_BASE_URL}/students`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(studentData)
        });

        const result = await response.json();

        if (result.success || response.ok) {
            showNotification('✅ Student added successfully!', 'success');
            closeModal();
            await loadAllStudents();
        } else {
            showNotification('❌ ' + (result.error || 'Failed to add student'), 'error');
        }
    } catch (error) {
        showNotification('❌ Error: ' + error.message, 'error');
    } finally {
        showLoading(false);
    }
}

// ============================================================================
// BULK UPLOAD
// ============================================================================

function openBulkUploadModal() {
    const streamSelect = document.getElementById('bulkStream');
    streamSelect.innerHTML = '<option value="">Select Stream</option>';
    availableStreams.forEach(stream => {
        const option = document.createElement('option');
        option.value = stream;
        option.textContent = stream;
        streamSelect.appendChild(option);
    });

    document.getElementById('bulkUploadModal').classList.remove('hidden');
    document.getElementById('bulkUploadModal').classList.add('active');
}

function closeBulkUploadModal() {
    document.getElementById('bulkUploadModal').classList.remove('active');
    setTimeout(() => document.getElementById('bulkUploadModal').classList.add('hidden'), 300);
    document.getElementById('bulkFileInput').value = '';
    document.getElementById('bulkFileName').textContent = '';
}

document.getElementById('bulkFileInput')?.addEventListener('change', function (e) {
    const fileName = e.target.files[0]?.name || '';
    document.getElementById('bulkFileName').textContent = fileName ? `✓ Selected: ${fileName}` : '';
});

async function processBulkUpload() {
    const stream = document.getElementById('bulkStream').value;
    const semester = document.getElementById('bulkSemester').value;

    if (!stream || !semester) {
        showNotification('⚠️ Please select Stream and Semester', 'warning');
        return;
    }

    const fileInput = document.getElementById('bulkFileInput');
    const file = fileInput.files[0];

    if (!file) {
        showNotification('⚠️ Please select an Excel file', 'warning');
        return;
    }

    const reader = new FileReader();
    reader.onload = async function (e) {
        try {
            showLoading(true);

            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: "" });

            if (!Array.isArray(jsonData) || jsonData.length === 0) {
                showNotification('⚠️ Excel file is empty', 'warning');
                showLoading(false);
                return;
            }

            const getVal = (row, possibleKeys) => {
                const keys = Object.keys(row);
                for (let key of possibleKeys) {
                    const normalizedTargetKey = key.replace(/[\s_.-]/g, '').toLowerCase();
                    const match = keys.find(k => k.replace(/[\s_.-]/g, '').toLowerCase() === normalizedTargetKey);
                    if (match && row[match] !== undefined && row[match] !== null && String(row[match]).trim() !== '') {
                        return String(row[match]).trim();
                    }
                }
                return '';
            };

            const students = jsonData.map(row => ({
                studentID: getVal(row, ['studentID', 'ID', 'Student ID', 'student ID', 'USN']),
                name: getVal(row, ['name', 'Student Name', 'fullname']),
                parentPhone: getVal(row, ['parentPhone', 'Phone', 'Mobile']),
                languageSubject: getVal(row, ['languageSubject', 'Language']),
                electiveSubject: getVal(row, ['electiveSubject', 'Elective']),
                stream: stream,
                semester: parseInt(semester),
                academicYear: new Date().getFullYear(),
                isActive: true
            }));

            console.log("📊 Raw Row 1:", JSON.stringify(jsonData[0]));
            console.log("🚀 Mapped Student 1:", JSON.stringify(students[0]));
            console.log(`📊 Validating: ${students.filter(s => s.studentID && s.name).length} / ${students.length} are valid`);

            const response = await fetch(`${API_BASE_URL}/students/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ students })
            });

            const result = await response.json();

            if (result.success) {
                showNotification(`✅ ${result.insertedCount} students uploaded!`, 'success');
                closeBulkUploadModal();
                await loadAllStudents();
            } else {
                showNotification('❌ ' + (result.error || 'Upload failed'), 'error');
            }
        } catch (error) {
            console.error('Error:', error);
            showNotification('❌ Error: ' + (error.message || 'Error processing file'), 'error');
        } finally {
            showLoading(false);
        }
    };

    reader.readAsArrayBuffer(file);
}

// ============================================================================
// STREAM MODAL
// ============================================================================

function openAddStreamModal() {
    document.getElementById('addDropdown').classList.add('hidden');
    document.getElementById('streamModal').classList.remove('hidden');
    document.getElementById('streamModal').classList.add('active');
}

function closeStreamModal() {
    document.getElementById('streamModal').classList.remove('active');
    setTimeout(() => document.getElementById('streamModal').classList.add('hidden'), 300);
}

async function submitStream(event) {
    event.preventDefault();

    const name = document.getElementById('streamName').value.trim();
    const streamCode = document.getElementById('streamCode').value.trim();
    const semesters = document.getElementById('streamSemesters').value;

    if (!name || !streamCode || !semesters) {
        showNotification('⚠️ Please fill all fields', 'warning');
        return;
    }

    try {
        showLoading(true);
        const response = await fetch(`${API_BASE_URL}/students/management/streams`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, streamCode, semesters })
        });

        const result = await response.json();

        if (result.success) {
            showNotification(`✅ Stream "${name}" added!`, 'success');
            closeStreamModal();
            await loadAllStudents();
        } else {
            showNotification('❌ Error: ' + result.message, 'error');
        }
    } catch (error) {
        showNotification('❌ Network error', 'error');
    } finally {
        showLoading(false);
    }
}

// ============================================================================
// SUBJECT MODAL
// ============================================================================

async function openAddSubjectModal() {
    document.getElementById('addDropdown').classList.add('hidden');
    document.getElementById('subjectModal').classList.remove('hidden');
    document.getElementById('subjectModal').classList.add('active');
    await loadStreamsForSubject();
}

function closeSubjectModal() {
    document.getElementById('subjectModal').classList.remove('active');
    setTimeout(() => document.getElementById('subjectModal').classList.add('hidden'), 300);
    document.getElementById('languageFields').classList.add('hidden');
}

async function loadStreamsForSubject() {
    try {
        const response = await fetch(`${API_BASE_URL}/students/management/streams`);
        const data = await response.json();

        const select = document.getElementById('subjectStream');
        select.innerHTML = '<option value="">Select Stream</option>';

        if (data.success && data.streams) {
            data.streams.forEach(stream => {
                const option = document.createElement('option');
                option.value = stream.name;
                option.textContent = stream.name;
                select.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading streams:', error);
    }
}

function toggleLanguageFields() {
    const subjectType = document.getElementById('subjectType').value;
    const languageFields = document.getElementById('languageFields');

    if (subjectType === 'LANGUAGE') {
        languageFields.classList.remove('hidden');
    } else {
        languageFields.classList.add('hidden');
        document.getElementById('languageType').value = '';
    }
}

async function submitSubject(event) {
    event.preventDefault();

    const name = document.getElementById('subjectName').value.trim();
    const subjectCode = document.getElementById('subjectCode').value.trim();
    const stream = document.getElementById('subjectStream').value;
    const semester = document.getElementById('subjectSemester').value;
    const subjectType = document.getElementById('subjectType').value;
    const languageType = document.getElementById('languageType').value || null;

    if (!name || !subjectCode || !stream || !semester || !subjectType) {
        showNotification('⚠️ Please fill all required fields', 'warning');
        return;
    }

    try {
        showLoading(true);
        const response = await fetch(`${API_BASE_URL}/students/management/subjects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name, subjectCode, stream, semester, subjectType,
                isLanguageSubject: subjectType === 'LANGUAGE',
                languageType
            })
        });

        const result = await response.json();

        if (result.success) {
            showNotification(`✅ Subject "${name}" added!`, 'success');
            closeSubjectModal();
        } else {
            showNotification('❌ Error: ' + result.message, 'error');
        }
    } catch (error) {
        showNotification('❌ Network error', 'error');
    } finally {
        showLoading(false);
    }
}

// ============================================================================
// DROPDOWN MANAGEMENT
// ============================================================================

function toggleAddDropdown() {
    const dropdown = document.getElementById('addDropdown');
    dropdown.classList.toggle('hidden');
}

document.addEventListener('click', function (event) {
    const dropdown = document.getElementById('addDropdown');
    const dropdownContainer = event.target.closest('.dropdown-container');

    if (!dropdownContainer && dropdown && !dropdown.classList.contains('hidden')) {
        dropdown.classList.add('hidden');
    }
});

function openAddStudentModal() {
    document.getElementById('addDropdown').classList.add('hidden');
    openAddModal();
}

// ============================================================================
// UTILITIES
// ============================================================================

async function refreshData() {
    await loadAllStudents();
    clearSelection();
}

function showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        if (show) {
            overlay.classList.add('show');
        } else {
            overlay.classList.remove('show');
        }
    }
}

function showEmptyState(title, message) {
    const tbody = document.getElementById('studentTableBody');
    if (!tbody) return;

    tbody.innerHTML = `
        <tr>
            <td colspan="11" style="text-align: center; padding: 3rem; color: #6b7280;">
                <i class="material-icons-round" style="font-size: 3rem; margin-bottom: 1rem; display: block; opacity: 0.5;">inbox</i>
                <div style="font-size: 1.125rem; font-weight: 600; margin-bottom: 0.5rem;">${title}</div>
                <div style="font-size: 0.875rem; margin-bottom: 1rem;">${message}</div>
                <button onclick="loadAllStudents()" class="modern-btn btn-primary">
                    <i class="material-icons-round">refresh</i>
                    Retry
                </button>
            </td>
        </tr>
    `;
}

function updateAllStats() {
    try {
        const totalCountEl = document.getElementById('totalCount');
        if (totalCountEl) totalCountEl.textContent = allStudents.length;

        const filteredCountEl = document.getElementById('filteredCount');
        if (filteredCountEl) filteredCountEl.textContent = filteredStudents.length;

        const streamsCountEl = document.getElementById('streamsCount');
        if (streamsCountEl) streamsCountEl.textContent = availableStreams.length;

        const activeCount = allStudents.filter(s => s.isActive !== false).length;
        const activeCountEl = document.getElementById('activeCount');
        if (activeCountEl) activeCountEl.textContent = activeCount;
    } catch (error) {
        console.error('Error updating stats:', error);
    }
}

// ============================================================================
// MODAL CLOSE ON OUTSIDE CLICK
// ============================================================================

document.addEventListener('click', function (event) {
    const studentModal = document.getElementById('studentModal');
    if (event.target === studentModal && !studentModal.classList.contains('hidden')) {
        closeModal();
    }

    const bulkModal = document.getElementById('bulkUploadModal');
    if (event.target === bulkModal && !bulkModal.classList.contains('hidden')) {
        closeBulkUploadModal();
    }

    const streamModal = document.getElementById('streamModal');
    if (event.target === streamModal && !streamModal.classList.contains('hidden')) {
        closeStreamModal();
    }

    const subjectModal = document.getElementById('subjectModal');
    if (event.target === subjectModal && !subjectModal.classList.contains('hidden')) {
        closeSubjectModal();
    }
});

// ============================================================================
// MAKE FUNCTIONS GLOBAL
// ============================================================================

window.refreshData = refreshData;
window.openAddModal = openAddModal;
window.openAddStudentModal = openAddStudentModal;
window.closeModal = closeModal;
window.saveStudent = saveStudent;
window.exportData = exportData;
window.applyFilters = applyFilters;
window.debounceSearch = debounceSearch;
window.toggleSelectAll = toggleSelectAll;
window.toggleStudentSelection = toggleStudentSelection;
window.deleteStudent = deleteStudent;
window.bulkExport = bulkExport;
window.bulkUpdateStatus = bulkUpdateStatus;
window.bulkDelete = bulkDelete;
window.clearSelection = clearSelection;
window.openBulkUploadModal = openBulkUploadModal;
window.closeBulkUploadModal = closeBulkUploadModal;
window.processBulkUpload = processBulkUpload;
window.toggleAddDropdown = toggleAddDropdown;
window.openAddStreamModal = openAddStreamModal;
window.closeStreamModal = closeStreamModal;
window.submitStream = submitStream;
window.openAddSubjectModal = openAddSubjectModal;
window.closeSubjectModal = closeSubjectModal;
window.submitSubject = submitSubject;
window.toggleLanguageFields = toggleLanguageFields;

console.log('✅ Student Management System - All functions loaded and ready!');
