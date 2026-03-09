import express from 'express';
import cors from 'cors';
import prisma from './db/db';

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3001;

// GET /api/menu -> fetch weekly menu
app.get('/api/menu', async (req, res) => {
  try {
    const menus = await prisma.menu.findMany();

    // Transform flat menu records into the WeeklyMenu structure frontend expects
    const weeklyMenu: Record<string, any> = {
      Monday: { Breakfast: "", Lunch: "", Dinner: "" },
      Tuesday: { Breakfast: "", Lunch: "", Dinner: "" },
      Wednesday: { Breakfast: "", Lunch: "", Dinner: "" },
      Thursday: { Breakfast: "", Lunch: "", Dinner: "" },
      Friday: { Breakfast: "", Lunch: "", Dinner: "" },
      Saturday: { Breakfast: "", Lunch: "", Dinner: "" },
      Sunday: { Breakfast: "", Lunch: "", Dinner: "" }
    };

    menus.forEach(menu => {
      if (weeklyMenu[menu.dayOfWeek]) {
        weeklyMenu[menu.dayOfWeek][menu.mealType] = menu.items;
      }
    });

    return res.json(weeklyMenu);
  } catch (error) {
    console.error("Error fetching menu:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/menu -> update specific meal for a day
app.post('/api/menu', async (req, res) => {
  const { dayOfWeek, mealType, items } = req.body;

  if (!dayOfWeek || !mealType) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const updatedMenu = await prisma.menu.upsert({
      where: {
        // Requires a unique constraint on dayOfWeek_mealType
        dayOfWeek_mealType: {
          dayOfWeek,
          mealType
        }
      },
      update: {
        items
      },
      create: {
        dayOfWeek,
        mealType,
        items
      }
    });
    return res.json(updatedMenu);
  } catch (error) {
    console.error("Error updating menu:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/entries -> fetch all daily waste entries
app.get('/api/entries', async (req, res) => {
  try {
    // We fetch and aggregate the entries to match DailyEntry format
    const rawEntries = await prisma.messEntry.findMany({
      orderBy: { date: 'asc' }
    });

    // We can group them by date (YYYY-MM-DD) if there are multiple meals per day
    const entriesMap = new Map<string, { date: string, dayOfWeek: string, totalWaste: number }>();

    rawEntries.forEach(entry => {
      if (entriesMap.has(entry.date)) {
        entriesMap.get(entry.date)!.totalWaste += entry.foodwastedKg;
      } else {
        entriesMap.set(entry.date, {
          date: entry.date,
          dayOfWeek: entry.dayOfWeek,
          totalWaste: entry.foodwastedKg
        });
      }
    });

    const entries = Array.from(entriesMap.values());
    return res.json(entries);
  } catch (error) {
    console.error("Error fetching entries:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/entries -> add a new entry
app.post('/api/entries', async (req, res) => {
  const {
    date,
    dayOfWeek,
    mealType,
    foodPrepared,
    foodWasted,
    totalStudents,
    totalStudentsAte
  } = req.body;

  try {
    const newEntry = await prisma.messEntry.create({
      data: {
        date,
        dayOfWeek,
        mealtype: mealType,
        foodpreparedkg: Number(foodPrepared),
        foodwastedKg: Number(foodWasted),
        studentsAte: Number(totalStudentsAte),
        studentsTotal: Number(totalStudents)
      }
    });

    return res.json(newEntry);
  } catch (err) {
    console.error("Error creating entry:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Helper to get start and end dates of the current month
const getMonthRange = (date: Date) => {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return { start, end };
};

// GET /api/stats -> get aggregate stats for dashboard with MoM Trends
app.get('/api/stats', async (req, res) => {
  try {
    const allEntries = await prisma.messEntry.findMany();

    const now = new Date();
    // Current month range based on JS Date (e.g., March)
    const currentMonthTarget = now.getMonth();
    const currentYearTarget = now.getFullYear();

    // Previous month range (e.g., February)
    let prevMonthTarget = currentMonthTarget - 1;
    let prevYearTarget = currentYearTarget;
    if (prevMonthTarget < 0) {
      prevMonthTarget = 11;
      prevYearTarget -= 1;
    }

    let thisMonthWaste = 0;
    let thisMonthPrepared = 0;
    let thisMonthDays = new Set<string>();

    let lastMonthWaste = 0;
    let lastMonthPrepared = 0;
    let lastMonthDays = new Set<string>();

    allEntries.forEach(entry => {
      // Parse the 'YYYY-MM-DD' stored string back to Date safely
      const entryDate = new Date(entry.date);
      const m = entryDate.getMonth();
      const y = entryDate.getFullYear();

      if (m === currentMonthTarget && y === currentYearTarget) {
        thisMonthWaste += entry.foodwastedKg;
        thisMonthPrepared += entry.foodpreparedkg;
        thisMonthDays.add(entry.date);
      } else if (m === prevMonthTarget && y === prevYearTarget) {
        lastMonthWaste += entry.foodwastedKg;
        lastMonthPrepared += entry.foodpreparedkg;
        lastMonthDays.add(entry.date);
      }
    });

    // 1. Total Waste
    const totalWasteStr = thisMonthWaste.toFixed(1);
    
    // 2. Avg Daily Waste
    const thisMonthAvg = thisMonthDays.size > 0 ? thisMonthWaste / thisMonthDays.size : 0;
    const lastMonthAvg = lastMonthDays.size > 0 ? lastMonthWaste / lastMonthDays.size : 0;
    const avgDailyWasteStr = thisMonthAvg.toFixed(1);

    // 3. Waste Percentage
    const thisMonthPerc = thisMonthPrepared > 0 ? (thisMonthWaste / thisMonthPrepared) * 100 : 0;
    const lastMonthPerc = lastMonthPrepared > 0 ? (lastMonthWaste / lastMonthPrepared) * 100 : 0;
    const wastePercentageStr = thisMonthPerc.toFixed(1);

    // 4. Est Cost Loss (Assume ₹50 per kg)
    const thisMonthCost = thisMonthWaste * 50;
    const lastMonthCost = lastMonthWaste * 50;
    const estCostLossStr = "₹" + thisMonthCost.toLocaleString();

    // Trend calculations (MoM %)
    const calcTrend = (current: number, previous: number, isCurrency: boolean = false) => {
      if (previous === 0) return current > 0 ? "+100%" : "0%";
      const diff = current - previous;
      const perc = (diff / previous) * 100;
      const sign = perc > 0 ? "+" : "";
      
      // For currency, maybe we just show absolute difference trend: "+₹1,200"
      if (isCurrency) {
        return diff > 0 
          ? `+₹${diff.toLocaleString()}`
          : `-₹${Math.abs(diff).toLocaleString()}`;
      }

      return `${sign}${perc.toFixed(1)}%`;
    };

    const totalWasteTrend = calcTrend(thisMonthWaste, lastMonthWaste);
    const avgDailyTrend = calcTrend(thisMonthAvg, lastMonthAvg);
    // Waste Percentage trend looks weird as a % of a %. Just show absolute diff in percentage points
    const percDiff = thisMonthPerc - lastMonthPerc;
    const percSign = percDiff > 0 ? "+" : "";
    const wastePercTrend = `${percSign}${percDiff.toFixed(1)}%`;
    const costTrend = calcTrend(thisMonthCost, lastMonthCost, true);

    return res.json({
      totalWaste: { value: `${totalWasteStr} kg`, trend: totalWasteTrend, trendType: thisMonthWaste > lastMonthWaste ? "bad" : "good" },
      avgDailyWaste: { value: `${avgDailyWasteStr} kg`, trend: avgDailyTrend, trendType: thisMonthAvg > lastMonthAvg ? "bad" : "good" },
      wastePercentage: { value: `${wastePercentageStr}%`, trend: wastePercTrend, trendType: thisMonthPerc > lastMonthPerc ? "bad" : "good" },
      estCostLoss: { value: estCostLossStr, trend: costTrend, trendType: thisMonthCost > lastMonthCost ? "bad" : "good" }
    });

  } catch (error) {
    console.error("Error fetching stats:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/insights -> generated dynamic recommendations
app.get('/api/insights', async (req, res) => {
  try {
    const allEntries = await prisma.messEntry.findMany();
    const insights = [];

    if (allEntries.length === 0) {
      insights.push({
        type: "info",
        title: "No Data Available",
        description: "Start logging daily waste entries to generate dynamic insights and recommendations."
      });
      return res.json(insights);
    }

    // Insight 1: Highest Waste Meal / Day
    const wasteByMealAndDay = new Map<string, { waste: number, count: number }>();
    allEntries.forEach(entry => {
      const key = `${entry.dayOfWeek} ${entry.mealtype}`;
      if (!wasteByMealAndDay.has(key)) {
        wasteByMealAndDay.set(key, { waste: 0, count: 0 });
      }
      const data = wasteByMealAndDay.get(key)!;
      data.waste += entry.foodwastedKg;
      data.count += 1;
    });

    let highestKey = "";
    let highestAvg = 0;

    wasteByMealAndDay.forEach((data, key) => {
      const avg = data.waste / data.count;
      if (avg > highestAvg) {
        highestAvg = avg;
        highestKey = key;
      }
    });

    if (highestKey) {
      insights.push({
        type: "bad",
        title: `Highest Waste Meal: ${highestKey}`,
        description: `This meal averages ${highestAvg.toFixed(1)} kg of waste. Consider reviewing the menu items or estimating student count more carefully for this shift to reduce excess.`
      });
    }

    // Insight 2: Recent Improvement or Degradation
    // Sort desc by date
    allEntries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
    // Look at the most recent 7 days vs previous 7 days (if exists)
    const recent7 = allEntries.slice(0, 7);
    const prev7 = allEntries.slice(7, 14);

    if (recent7.length > 0 && prev7.length > 0) {
      const recentWaste = recent7.reduce((sum, e) => sum + e.foodwastedKg, 0) / recent7.length;
      const prevWaste = prev7.reduce((sum, e) => sum + e.foodwastedKg, 0) / prev7.length;

      if (recentWaste < prevWaste) {
        const diff = (((prevWaste - recentWaste) / prevWaste) * 100).toFixed(1);
        insights.push({
          type: "good",
          title: "Improving Efficiency",
          description: `Great job! Your recent daily average waste has decreased by ${diff}% compared to the prior period.`
        });
      } else if (recentWaste > prevWaste) {
        const diff = (((recentWaste - prevWaste) / prevWaste) * 100).toFixed(1);
        insights.push({
          type: "bad",
          title: "Waste Increasing",
          description: `Notice: Recent average daily waste is up ${diff}% compared to the prior period. Monitor prep quantities closely.`
        });
      }
    }

    // Fallback if not enough data for Insight 2
    if (insights.length < 2) {
      insights.push({
        type: "good",
        title: "Data Collection Active",
        description: "You're actively tracking data! Continue logging daily to unlock more detailed trends and predictions."
      });
    }

    return res.json(insights);

  } catch (error) {
    console.error("Error generating insights:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/charts -> returns data for Dashboard charts
app.get('/api/charts', async (req, res) => {
  try {
    const allEntries = await prisma.messEntry.findMany({
      orderBy: { date: 'asc' }
    });

    // 1. Waste Trend (Last 7 Days)
    // Create a map of the last 7 days of entries
    const trendMap = new Map<string, number>();
    
    // Quick grouping by dayOfWeek for simplicity in the chart
    // A better approach is grouping by actual Date strings, but the frontend chart uses short day names ("Mon", "Tue")
    const shortDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    
    // To ensure we get a timeline, we take the last 7 unique days from the entries
    // Or just group by dayOfWeek of all entries if there's very little data
    const recentEntries = allEntries.slice(-21); // Grab a reasonable chunk
    recentEntries.forEach(entry => {
      const d = new Date(entry.date);
      const shortDay = shortDays[d.getDay()];
      trendMap.set(shortDay, (trendMap.get(shortDay) || 0) + entry.foodwastedKg);
    });

    let trendData: {day: string, waste: number}[] = [];
    if (trendMap.size === 0) {
      // Empty state
      trendData = [
        { day: "Mon", waste: 0 }, { day: "Tue", waste: 0 }, { day: "Wed", waste: 0 },
        { day: "Thu", waste: 0 }, { day: "Fri", waste: 0 }, { day: "Sat", waste: 0 }, { day: "Sun", waste: 0 }
      ];
    } else {
      trendData = Array.from(trendMap.entries()).map(([day, waste]) => ({
        day, waste: Number(waste.toFixed(1))
      }));
    }

    // 2. Meal Type Data
    let breakfastWaste = 0;
    let lunchWaste = 0;
    let dinnerWaste = 0;

    allEntries.forEach(entry => {
      if (entry.mealtype.toLowerCase() === "breakfast") breakfastWaste += entry.foodwastedKg;
      else if (entry.mealtype.toLowerCase() === "lunch") lunchWaste += entry.foodwastedKg;
      else if (entry.mealtype.toLowerCase() === "dinner") dinnerWaste += entry.foodwastedKg;
    });

    const mealTypeData = [
      { name: "Breakfast", waste: Number(breakfastWaste.toFixed(1)) },
      { name: "Lunch", waste: Number(lunchWaste.toFixed(1)) },
      { name: "Dinner", waste: Number(dinnerWaste.toFixed(1)) },
    ];

    return res.json({
      trendData,
      mealTypeData
    });

  } catch (error) {
    console.error("Error generating charts data:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

app.listen(port, () => {
  console.log(`Server up on port ${port}`);
});