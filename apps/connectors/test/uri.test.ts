import test from "node:test";
import assert from "node:assert/strict";
import { testUri } from "./fakes";

test("tests never borrow the app's database: MONGODB_URI is ignored, only MONGODB_TEST_URI or local", () => {
  assert.equal(testUri({ MONGODB_URI: "mongodb+srv://u:p@cluster0.example.net" }), "mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true");
  assert.equal(testUri({ MONGODB_TEST_URI: "mongodb://10.0.0.5:27017" }), "mongodb://10.0.0.5:27017");
});
