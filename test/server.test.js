const test = require("node:test");
const assert = require("node:assert/strict");
const { getSummary, getFeedbackSummary, getDishComparison, filterFeedback, buildPdfReport, buildListPdf, validateEntry, recommendAction } = require("../server");

test("validates required fields", () => {
  assert.match(validateEntry({}), /Missing required fields/);
  assert.equal(validateEntry({ foodItem: "Rice", category: "Cooked", source: "Counter", quantity: 2, unit: "kg", action: "Compost" }), null);
});

test("summarizes records", () => {
  const summary = getSummary([
    { foodItem: "Rice", category: "Cooked", quantity: 2, unit: "kg", action: "Compost" },
    { foodItem: "Rice", category: "Cooked", quantity: 500, unit: "g", action: "Disposal" }
  ]);
  assert.equal(summary.totalKg, 2.5);
  assert.equal(summary.totalEntries, 2);
  assert.equal(summary.divertedEntries, 1);
  assert.deepEqual(summary.topFood, { name: "Rice", kg: 2.5 });
});

test("keeps untouched surplus behind a food-safety assessment", () => {
  assert.match(recommendAction("Untouched surplus", "Serving counter"), /food-safety assessment/i);
  assert.match(recommendAction("Non-food contamination", "Customer plate waste"), /Separate packaging/i);
});

test("calculates operational sustainability metrics", () => {
  const action = recommendAction("Cooked food waste", "Serving counter");
  const summary = getSummary([
    { foodItem: "Rice", category: "Cooked food waste", source: "Serving counter", meal: "Lunch", reason: "Overproduction", quantity: 4, unit: "kg", mealsServed: 200, action, actionTaken: action, createdAt: new Date().toISOString() },
    { foodItem: "Peels", category: "Fruit & vegetable waste", source: "Kitchen preparation", meal: "Lunch", reason: "Preparation scraps", quantity: 1, unit: "kg", mealsServed: 0, action: "Compost", actionTaken: "Compost", createdAt: new Date().toISOString() }
  ]);
  assert.equal(summary.wastePer100Meals, 2.5);
  assert.equal(summary.avoidableKg, 4);
  assert.equal(summary.unavoidableKg, 1);
  assert.equal(summary.correctSegregationRate, 100);
  assert.equal(summary.bySource[0].name, "Serving counter");
});

test("summarizes customer feedback", () => {
  const summary = getFeedbackSummary([
    { foodRating: 5, portionRating: 4, portionAssessment: "Over portion", mealType: "Lunch", serviceDate: "2026-08-21", leftoverReason: "Portion too large", smallerPortion: "Yes", menuVote: "Dosa" },
    { foodRating: 3, portionRating: 2, portionAssessment: "Right portion", mealType: "Lunch", serviceDate: "2026-08-21", leftoverReason: "Portion too large", smallerPortion: "No", menuVote: "Dosa" }
  ]);
  assert.equal(summary.averageFoodRating, 4);
  assert.equal(summary.averagePortionRating, 3);
  assert.deepEqual(summary.topLeftoverReason, { name: "Portion too large", count: 2 });
  assert.equal(summary.overPortionResponses, 1);
  assert.deepEqual(summary.topMealType, { name: "Lunch", count: 2 });
  assert.deepEqual(summary.topMenuVote, { name: "Dosa", count: 2 });
  assert.match(summary.topOverPortionPattern.name, /Lunch/);
});

test("builds a valid PDF report", () => {
  const pdf = buildPdfReport({ totalKg: 2, wastePer100Meals: 1, mealsServed: 200, weeklyKg: 2, previousWeekKg: 1, monthlyKg: 2, previousMonthKg: 1, avoidableKg: 2, unavoidableKg: 0, correctSegregationRate: 100, insights: ["Reduce rice portions."] }, { totalResponses: 1, averageFoodRating: 4, averagePortionRating: 3, wouldChooseSmallerPortion: 1, topLeftoverReason: { name: "Portion too large" } }, []);
  assert.equal(pdf.subarray(0, 8).toString(), "%PDF-1.4");
  assert.match(pdf.toString("binary"), /%%EOF$/);
});

test("builds valid list PDFs for history and feedback", () => {
  const pdf = buildListPdf("FoodWise Test Report", [{ heading: "Records", lines: ["Rice | 2 kg", "Lunch feedback | 4/5"] }]);
  assert.equal(pdf.subarray(0, 8).toString(), "%PDF-1.4");
  assert.match(pdf.toString("binary"), /FoodWise Test Report/);
});

test("filters reviews and compares dish ratings with waste", () => {
  const feedback = [
    { meal: "Rice", mealType: "Lunch", serviceDate: "2026-08-21", reviewStatus: "New", foodRating: 4 },
    { meal: "Soup", mealType: "Dinner", serviceDate: "2026-08-20", reviewStatus: "Reviewed", foodRating: 5 }
  ];
  const params = new URLSearchParams({ mealType: "Lunch", status: "New" });
  assert.equal(filterFeedback(feedback, params).length, 1);
  const comparison = getDishComparison([{ foodItem: "Cooked rice", quantity: 2, unit: "kg" }], feedback);
  assert.equal(comparison.find(item => item.name === "Rice").wasteKg, 2);
  assert.equal(comparison.find(item => item.name === "Rice").rating, 4);
});
