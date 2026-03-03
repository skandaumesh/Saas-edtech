// routes/dashboardRoutes.js
const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

// ============================================================================
// MIDDLEWARE
// ============================================================================

const checkDB = (req, res, next) => {
  const db = req.app.locals.db || req.app.get('db');
  if (!db) {
    return res.status(503).json({
      success: false,
      error: 'Database connection not available'
    });
  }
  req.db = db;
  next();
};

router.use(checkDB);

// ============================================================================
// DASHBOARD STATISTICS
// ============================================================================

// GET Dashboard Overview Stats - SaaS Focused
router.get('/stats', async (req, res) => {
  try {
    console.log('📊 Fetching SaaS dashboard statistics...');

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    // Get current date info
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    // Use LOCAL date formatting to avoid UTC timezone shift
    const getDateStr = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const today = getDateStr(now);

    // Calculate date ranges
    const startOfToday = new Date(currentYear, currentMonth, now.getDate());
    const endOfToday = new Date(currentYear, currentMonth, now.getDate() + 1);
    const startOfWeek = new Date(currentYear, currentMonth, now.getDate() - now.getDay());
    const startOfLastWeek = new Date(startOfWeek);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);
    const startOfMonth = new Date(currentYear, currentMonth, 1);

    // Build date strings for the week ranges (for querying by 'date' field)
    const thisWeekDateStrs = [];
    for (let d = new Date(startOfWeek); d <= startOfToday; d.setDate(d.getDate() + 1)) {
      thisWeekDateStrs.push(getDateStr(d));
    }
    const lastWeekDateStrs = [];
    for (let d = new Date(startOfLastWeek); d < startOfWeek; d.setDate(d.getDate() + 1)) {
      lastWeekDateStrs.push(getDateStr(d));
    }
    console.log('📅 Date debug: today=', today, 'thisWeekDateStrs=', thisWeekDateStrs);

    // ========== CORE STATS ==========
    const [
      totalStudents,
      activeStudents,
      totalStreams,
      totalSubjects,
      todayAttendance,
      thisWeekAttendance,
      lastWeekAttendance,
      allStreams
    ] = await Promise.all([
      req.db.collection('students').distinct('studentID').then(arr => arr.filter(id => id != null).length),
      req.db.collection('students').distinct('studentID', { isActive: true }).then(arr => arr.filter(id => id != null).length),
      req.db.collection('students').distinct('stream', { isActive: true }).then(arr => arr.length),
      req.db.collection('subjects').countDocuments({ isActive: true }),
      req.db.collection('attendance').find({ date: today }).toArray(),
      req.db.collection('attendance').find({ date: { $in: thisWeekDateStrs } }).toArray(),
      req.db.collection('attendance').find({ date: { $in: lastWeekDateStrs } }).toArray(),
      req.db.collection('students').distinct('stream', { isActive: true })
    ]);

    // ========== TODAY'S ATTENDANCE (Count globally unique students) ==========
    let todayPresent = 0, todayTotal = activeStudents;
    const uniqueStudentsToday = new Set();

    todayAttendance.forEach(r => {
      if (r.studentsPresent && Array.isArray(r.studentsPresent)) {
        r.studentsPresent.forEach(studentId => {
          uniqueStudentsToday.add(String(studentId));
        });
      }
    });

    todayPresent = uniqueStudentsToday.size;
    const todayAbsent = Math.max(0, todayTotal - todayPresent);
    const todayRate = todayTotal > 0 ? Math.min(100, Math.round((todayPresent / todayTotal) * 100)) : 0;

    // ========== WEEKLY COMPARISON (unique students per day, then average) ==========
    const thisWeekDays = new Map();
    thisWeekAttendance.forEach(r => {
      const dateStr = r.date || (r.createdAt ? new Date(r.createdAt).toISOString().split('T')[0] : null);
      if (!dateStr) return;
      if (!thisWeekDays.has(dateStr)) thisWeekDays.set(dateStr, new Set());
      if (r.studentsPresent && Array.isArray(r.studentsPresent)) {
        r.studentsPresent.forEach(sid => thisWeekDays.get(dateStr).add(String(sid)));
      }
    });
    let thisWeekRateSum = 0;
    thisWeekDays.forEach(daySet => {
      thisWeekRateSum += activeStudents > 0 ? Math.min(100, (daySet.size / activeStudents) * 100) : 0;
    });
    const thisWeekRate = thisWeekDays.size > 0 ? Math.round(thisWeekRateSum / thisWeekDays.size) : 0;

    const lastWeekDays = new Map();
    lastWeekAttendance.forEach(r => {
      const dateStr = r.date || (r.createdAt ? new Date(r.createdAt).toISOString().split('T')[0] : null);
      if (!dateStr) return;
      if (!lastWeekDays.has(dateStr)) lastWeekDays.set(dateStr, new Set());
      if (r.studentsPresent && Array.isArray(r.studentsPresent)) {
        r.studentsPresent.forEach(sid => lastWeekDays.get(dateStr).add(String(sid)));
      }
    });
    let lastWeekRateSum = 0;
    lastWeekDays.forEach(daySet => {
      lastWeekRateSum += activeStudents > 0 ? Math.min(100, (daySet.size / activeStudents) * 100) : 0;
    });
    const lastWeekRate = lastWeekDays.size > 0 ? Math.round(lastWeekRateSum / lastWeekDays.size) : 0;
    const weeklyTrend = lastWeekRate > 0 ? thisWeekRate - lastWeekRate : 0;

    // ========== MONTHLY RATE (unique students per day, then average) ==========
    const monthStartStr = getDateStr(startOfMonth);
    const monthlyAttendance = await req.db.collection('attendance').find({
      date: { $gte: monthStartStr }
    }).toArray();
    const monthDays = new Map();
    monthlyAttendance.forEach(r => {
      const dateStr = r.date || (r.createdAt ? new Date(r.createdAt).toISOString().split('T')[0] : null);
      if (!dateStr) return;
      if (!monthDays.has(dateStr)) monthDays.set(dateStr, new Set());
      if (r.studentsPresent && Array.isArray(r.studentsPresent)) {
        r.studentsPresent.forEach(sid => monthDays.get(dateStr).add(String(sid)));
      }
    });
    let monthRateSum = 0;
    monthDays.forEach(daySet => {
      monthRateSum += activeStudents > 0 ? Math.min(100, (daySet.size / activeStudents) * 100) : 0;
    });
    const attendanceRate = monthDays.size > 0 ? Math.round(monthRateSum / monthDays.size) : 0;

    // ========== TOP PERFORMING STREAMS (by Stream + Semester) - ALL TIME ==========
    const streamStats = await req.db.collection('attendance').aggregate([
      {
        $group: {
          _id: { stream: '$stream', semester: '$semester' },
          totalPresent: { $sum: { $ifNull: ['$presentCount', 0] } },
          totalStudents: { $sum: { $ifNull: ['$totalStudents', 0] } },
          sessions: { $sum: 1 }
        }
      },
      { $match: { totalStudents: { $gt: 0 } } },
      {
        $project: {
          stream: '$_id.stream',
          semester: '$_id.semester',
          label: { $concat: ['$_id.stream', ' - Sem ', { $toString: '$_id.semester' }] },
          rate: { $round: [{ $multiply: [{ $divide: ['$totalPresent', '$totalStudents'] }, 100] }, 0] },
          sessions: 1
        }
      },
      { $sort: { rate: -1 } }
    ]).toArray();

    // ========== ALERTS ==========
    const alerts = [];
    const lowStreams = streamStats.filter(s => s.rate < 75);

    if (todayRate > 0 && todayRate < 70) {
      alerts.push({ type: 'warning', icon: 'warning', title: 'Low Attendance Today', description: `Only ${todayRate}% attendance today`, severity: 'high' });
    }
    if (weeklyTrend < -5) {
      alerts.push({ type: 'warning', icon: 'trending_down', title: 'Declining Trend', description: `${Math.abs(weeklyTrend)}% drop from last week`, severity: 'medium' });
    }
    if (lowStreams.length > 0) {
      const lowClassLabels = lowStreams.slice(0, 3).map(s => s.label || `${s.stream} - Sem ${s.semester}`).join(', ');
      alerts.push({ type: 'alert', icon: 'error', title: `${lowStreams.length} Classes Below 75%`, description: lowClassLabels, severity: 'high' });
    }
    if (todayRate >= 90) {
      alerts.push({ type: 'success', icon: 'check_circle', title: 'Great Attendance!', description: `${todayRate}% attendance today`, severity: 'low' });
    }
    if (todayAttendance.length === 0) {
      alerts.push({ type: 'info', icon: 'schedule', title: 'No Classes Marked', description: 'No attendance marked today yet', severity: 'low' });
    }

    // ========== CHARTS ==========
    const streamDistribution = await req.db.collection('students').aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$stream', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();

    // Attendance Trend - SaaS Style (Daily for last 15 days) - Fixed to avoid duplicate counting
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const attendanceTrendLabels = [];
    const attendanceTrendData = [];
    const dailyDataMap = new Map();

    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 14);
    fifteenDaysAgo.setHours(0, 0, 0, 0);

    // First, get all attendance records for last 15 days
    const trendRecords = await req.db.collection('attendance').find({
      date: { $gte: getDateStr(fifteenDaysAgo) }
    }).toArray();

    // Group by date, counting globally unique students
    const dailyStats = new Map();

    trendRecords.forEach(r => {
      const dateStr = r.date || null;
      if (!dateStr) return;

      if (!dailyStats.has(dateStr)) {
        dailyStats.set(dateStr, new Set());
      }

      const dayStudents = dailyStats.get(dateStr);

      if (r.studentsPresent && Array.isArray(r.studentsPresent)) {
        r.studentsPresent.forEach(studentId => {
          dayStudents.add(String(studentId));
        });
      }
    });

    // Calculate daily percentages using active students as total
    dailyStats.forEach((dayStudents, dateStr) => {
      const dateParts = dateStr.split('-');
      const key = `${parseInt(dateParts[0])}-${parseInt(dateParts[1])}-${parseInt(dateParts[2])}`;
      dailyDataMap.set(key, activeStudents > 0 ? Math.min(100, Math.round((dayStudents.size / activeStudents) * 100)) : 0);
    });

    // Fill in last 15 days
    for (let i = 14; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const m = d.getMonth() + 1;
      const day = d.getDate();
      const y = d.getFullYear();

      attendanceTrendLabels.push(`${day} ${monthNames[m - 1]}`);
      attendanceTrendData.push(dailyDataMap.get(`${y}-${m}-${day}`) || 0);
    }

    const streamDistLabels = streamDistribution.length > 0
      ? streamDistribution.map(s => s._id || 'Unknown')
      : ['No Streams'];
    const streamDistData = streamDistribution.length > 0
      ? streamDistribution.map(s => s.count)
      : [0];

    console.log('📊 Chart data prepared:', {
      attendanceTrend: { labels: attendanceTrendLabels, data: attendanceTrendData },
      streamDistribution: { labels: streamDistLabels, count: streamDistData.length }
    });

    const stats = {
      totalStudents, activeStudents, totalStreams, totalSubjects, attendanceRate,
      trends: { students: null, streams: null, subjects: null, attendance: weeklyTrend },
      studentsSubtitle: `${activeStudents} active`, streamsSubtitle: `${allStreams.length} programs`,
      subjectsSubtitle: `${totalSubjects} courses`, attendanceSubtitle: `This month's rate`,
      todayOverview: { present: todayPresent, absent: todayAbsent, total: todayTotal, rate: todayRate, classesMarked: todayAttendance.length, date: today },
      weeklyComparison: { thisWeek: thisWeekRate, lastWeek: lastWeekRate, trend: weeklyTrend, thisWeekSessions: thisWeekAttendance.length, lastWeekSessions: lastWeekAttendance.length },
      topPerformers: streamStats.map(s => ({
        stream: s.stream || 'Unknown',
        semester: s.semester,
        label: s.label || `${s.stream} - Sem ${s.semester}`,
        rate: s.rate,
        sessions: s.sessions
      })),
      alerts: alerts.slice(0, 4),
      charts: {
        attendanceTrend: { labels: attendanceTrendLabels, data: attendanceTrendData },
        streamDistribution: { labels: streamDistLabels, data: streamDistData }
      },
      timestamp: new Date()
    };

    console.log('✅ SaaS Dashboard:', { students: totalStudents, todayRate: todayRate + '%', alerts: alerts.length });
    res.json({ success: true, stats });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// RECENT ACTIVITIES
// ============================================================================

// GET Recent Activities
router.get('/activities', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;

    console.log(`📋 Fetching last ${limit} activities...`);

    // Fetch recent students
    const recentStudents = await req.db.collection('students')
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    // Fetch recent attendance records
    const recentAttendance = await req.db.collection('attendance')
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    const activities = [
      ...recentStudents.map(student => ({
        type: 'student_registered',
        title: `${student.name} registered`,
        description: `${student.stream} - Semester ${student.semester}`,
        timestamp: student.createdAt || new Date(),
        badge: 'new',
        avatar: student.name?.substring(0, 2).toUpperCase() || 'ST'
      })),
      ...recentAttendance.map(record => ({
        type: 'attendance_marked',
        title: 'Attendance marked',
        description: `${record.stream || 'N/A'} - ${record.subject || 'N/A'}`,
        timestamp: record.createdAt || new Date(),
        badge: 'completed',
        avatar: 'AT'
      }))
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, limit);

    console.log(`✅ Found ${activities.length} activities`);

    res.json({
      success: true,
      activities,
      count: activities.length
    });

  } catch (error) {
    console.error('❌ Error fetching activities:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// STREAM STATISTICS
// ============================================================================

// GET Stream-wise Statistics
router.get('/streams/stats', async (req, res) => {
  try {
    console.log('📚 Fetching stream-wise statistics...');

    const streamStats = await req.db.collection('students')
      .aggregate([
        { $match: { isActive: true } },
        {
          $group: {
            _id: '$stream',
            totalStudents: { $sum: 1 },
            semesters: { $addToSet: '$semester' }
          }
        },
        { $sort: { totalStudents: -1 } }
      ])
      .toArray();

    const formattedStats = streamStats.map(stat => ({
      stream: stat._id,
      totalStudents: stat.totalStudents,
      semesterCount: stat.semesters.length,
      semesters: stat.semesters.sort()
    }));

    console.log(`✅ Found ${formattedStats.length} streams`);

    res.json({
      success: true,
      streamStats: formattedStats,
      totalStreams: formattedStats.length
    });

  } catch (error) {
    console.error('❌ Error fetching stream stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// ATTENDANCE STATISTICS
// ============================================================================

// GET Attendance Statistics
router.get('/attendance/stats', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    console.log('📈 Fetching attendance statistics...');

    const query = {};
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = startDate;
      if (endDate) query.date.$lte = endDate;
    }

    const attendanceRecords = await req.db.collection('attendance')
      .find(query)
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    let totalPresent = 0;
    let totalAbsent = 0;
    let totalRecords = attendanceRecords.length;

    attendanceRecords.forEach(record => {
      totalPresent += (record.presentCount || record.studentsPresent?.length || 0);
      totalAbsent += (record.absentCount || 0);
    });

    const totalMarked = totalPresent + totalAbsent;
    const attendanceRate = totalMarked > 0 ? ((totalPresent / totalMarked) * 100).toFixed(2) : 0;

    // Daily attendance trends (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const localDateStr = (d) => { const y = d.getFullYear(); const m = String(d.getMonth()+1).padStart(2,'0'); const dy = String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${dy}`; };
    const sevenDaysAgoStr = localDateStr(sevenDaysAgo);

    const dailyTrends = await req.db.collection('attendance')
      .aggregate([
        {
          $match: {
            date: { $gte: sevenDaysAgoStr }
          }
        },
        {
          $group: {
            _id: '$date',
            present: { $sum: { $ifNull: ['$presentCount', 0] } },
            absent: { $sum: { $ifNull: ['$absentCount', 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ])
      .toArray();

    console.log(`✅ Found ${totalRecords} attendance records`);

    res.json({
      success: true,
      attendanceStats: {
        totalPresent,
        totalAbsent,
        totalRecords,
        attendanceRate: parseFloat(attendanceRate),
        dailyTrends: dailyTrends.map(d => ({
          date: d._id,
          present: d.present,
          absent: d.absent
        }))
      }
    });

  } catch (error) {
    console.error('❌ Error fetching attendance stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// QUICK SUMMARY
// ============================================================================

// GET Quick Dashboard Summary (for fast loading)
router.get('/summary', async (req, res) => {
  try {
    console.log('⚡ Fetching quick dashboard summary...');

    const [totalStudents, totalStreams, totalSubjects] = await Promise.all([
      req.db.collection('students').countDocuments({ isActive: true }),
      req.db.collection('students').distinct('stream', { isActive: true }).then(arr => arr.length),
      req.db.collection('subjects').countDocuments({ isActive: true })
    ]);

    // Quick attendance rate
    const recentAttendance = await req.db.collection('attendance')
      .find({})
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();

    let attendanceRate = 0;
    if (recentAttendance.length > 0) {
      const totalPresent = recentAttendance.reduce((sum, r) => sum + (r.presentCount || 0), 0);
      const totalMarked = recentAttendance.reduce((sum, r) => sum + (r.totalStudents || 0), 0);
      attendanceRate = totalMarked > 0 ? Math.round((totalPresent / totalMarked) * 100) : 0;
    }

    console.log('✅ Summary fetched successfully');

    res.json({
      success: true,
      summary: {
        totalStudents,
        totalStreams,
        totalSubjects,
        attendanceRate
      },
      timestamp: new Date()
    });

  } catch (error) {
    console.error('❌ Error fetching summary:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// ATTENDANCE TREND BY PERIOD (Week/Month/Year)
// ============================================================================

router.get('/attendance-trend', async (req, res) => {
  try {
    const period = req.query.period || 'month';
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    let daysToFetch, labelFormat;
    
    switch (period) {
      case 'week':
        daysToFetch = 7;
        labelFormat = 'day'; // Show day names
        break;
      case 'year':
        daysToFetch = 365;
        labelFormat = 'month'; // Show month names
        break;
      case 'month':
      default:
        daysToFetch = 30;
        labelFormat = 'date'; // Show dates
        break;
    }
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - (daysToFetch - 1));
    startDate.setHours(0, 0, 0, 0);
    
    // Local date string helper
    const localDateStr = (d) => { const y = d.getFullYear(); const m = String(d.getMonth()+1).padStart(2,'0'); const dy = String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${dy}`; };
    
    // Get all attendance records for the period
    const trendRecords = await req.db.collection('attendance').find({
      date: { $gte: localDateStr(startDate) }
    }).toArray();
    
    // Get total active students for rate calculation (unique by studentID)
    const activeStudentIDs = await req.db.collection('students').distinct('studentID', { isActive: true });
    const activeStudentCount = activeStudentIDs.filter(id => id != null).length;
    
    // Group by date, counting globally unique students
    const dailyStats = new Map();
    
    trendRecords.forEach(r => {
      const dateStr = r.date || null;
      if (!dateStr) return;
      
      if (!dailyStats.has(dateStr)) {
        dailyStats.set(dateStr, new Set());
      }
      
      const dayStudents = dailyStats.get(dateStr);
      
      if (r.studentsPresent && Array.isArray(r.studentsPresent)) {
        r.studentsPresent.forEach(studentId => {
          dayStudents.add(String(studentId));
        });
      }
    });
    
    // Calculate daily percentages using active students as total
    const dailyDataMap = new Map();
    dailyStats.forEach((dayStudents, dateStr) => {
      dailyDataMap.set(dateStr, activeStudentCount > 0 ? Math.min(100, Math.round((dayStudents.size / activeStudentCount) * 100)) : 0);
    });
    
    const labels = [];
    const data = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    if (labelFormat === 'month') {
      // For year view - aggregate by month
      const monthlyData = new Map();
      
      for (let i = 11; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const monthKey = `${d.getFullYear()}-${d.getMonth() + 1}`;
        monthlyData.set(monthKey, { total: 0, count: 0 });
      }
      
      dailyDataMap.forEach((rate, dateStr) => {
        const [y, m] = dateStr.split('-').map(Number);
        const key = `${y}-${m}`;
        if (monthlyData.has(key)) {
          const mData = monthlyData.get(key);
          mData.total += rate;
          mData.count += 1;
        }
      });
      
      monthlyData.forEach((mData, key) => {
        const [y, m] = key.split('-').map(Number);
        labels.push(monthNames[m - 1]);
        data.push(mData.count > 0 ? Math.round(mData.total / mData.count) : 0);
      });
      
    } else {
      // For week/month view - show each day
      for (let i = daysToFetch - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = localDateStr(d);
        
        if (labelFormat === 'day') {
          labels.push(dayNames[d.getDay()]);
        } else {
          labels.push(`${d.getDate()} ${monthNames[d.getMonth()]}`);
        }
        
        data.push(dailyDataMap.get(dateStr) || 0);
      }
    }
    
    console.log(`📊 Attendance trend (${period}):`, labels.length, 'data points');
    
    res.json({
      success: true,
      period,
      trend: { labels, data }
    });
    
  } catch (error) {
    console.error('❌ Error fetching attendance trend:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Dashboard API is running',
    database: req.db ? 'Connected' : 'Disconnected',
    timestamp: new Date()
  });
});

module.exports = router;
