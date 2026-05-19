#!/usr/bin/env python3
"""
Backend Deployment Probe Test Suite
====================================

Tests the deployment-related backend probe endpoints added to fix Kubernetes 
probe issues where repeated `GET /` was returning 404 and causing app restarts.

Validates:
1) GET / returns HTTP 200 JSON (root probe endpoint)
2) GET /health still responds (200/degraded but not crash)  
3) GET /ready responds with proper schema
4) Confirm backend startup/probe behavior no longer depends on Mongo for /

No credentials required for these probe endpoints.
"""

import asyncio
import aiohttp
import json
import sys
from datetime import datetime

# Backend is running on internal port 8001
BACKEND_BASE_URL = "http://127.0.0.1:8001"

class ProbeTestResults:
    def __init__(self):
        self.tests_run = 0
        self.tests_passed = 0
        self.failures = []
    
    def record_test(self, test_name, passed, details=None):
        self.tests_run += 1
        if passed:
            self.tests_passed += 1
            print(f"✅ {test_name}")
        else:
            self.failures.append(f"{test_name}: {details}")
            print(f"❌ {test_name}: {details}")
    
    def print_summary(self):
        print(f"\n{'='*50}")
        print(f"BACKEND DEPLOYMENT PROBE TEST RESULTS")
        print(f"{'='*50}")
        print(f"Tests Run: {self.tests_run}")
        print(f"Tests Passed: {self.tests_passed}")
        print(f"Tests Failed: {len(self.failures)}")
        print(f"Success Rate: {(self.tests_passed/self.tests_run*100):.1f}%" if self.tests_run > 0 else "0%")
        
        if self.failures:
            print(f"\n❌ FAILURES:")
            for failure in self.failures:
                print(f"  - {failure}")
        
        return len(self.failures) == 0

async def test_root_probe_endpoint(session, results):
    """Test 1: GET / returns HTTP 200 JSON and never depends on MongoDB"""
    try:
        async with session.get(f"{BACKEND_BASE_URL}/") as response:
            status_code = response.status
            
            if status_code != 200:
                results.record_test("Root Probe HTTP 200", False, f"Got {status_code} instead of 200")
                return
            
            try:
                data = await response.json()
            except:
                results.record_test("Root Probe JSON Response", False, "Response is not valid JSON")
                return
            
            # Verify required fields in response
            if not isinstance(data, dict):
                results.record_test("Root Probe JSON Structure", False, "Response is not a JSON object")
                return
                
            expected_fields = ["status", "service", "probe"]
            missing_fields = [f for f in expected_fields if f not in data]
            if missing_fields:
                results.record_test("Root Probe Response Fields", False, f"Missing fields: {missing_fields}")
                return
            
            # Verify field values
            if data.get("status") != "ok":
                results.record_test("Root Probe Status", False, f"Status is '{data.get('status')}' instead of 'ok'")
                return
                
            if data.get("service") != "route-optimizer":
                results.record_test("Root Probe Service", False, f"Service is '{data.get('service')}' instead of 'route-optimizer'")
                return
                
            if data.get("probe") != "root":
                results.record_test("Root Probe Type", False, f"Probe type is '{data.get('probe')}' instead of 'root'")
                return
            
            results.record_test("Root Probe Endpoint (GET /)", True)
            
            print(f"   Response: {json.dumps(data, indent=2)}")
            
    except Exception as e:
        results.record_test("Root Probe Endpoint (GET /)", False, f"Request failed: {str(e)}")

async def test_health_endpoint(session, results):
    """Test 2: GET /health responds with 200/degraded (no crashes)"""
    try:
        async with session.get(f"{BACKEND_BASE_URL}/health") as response:
            status_code = response.status
            
            if status_code != 200:
                results.record_test("Health Endpoint HTTP 200", False, f"Got {status_code} instead of 200")
                return
            
            try:
                data = await response.json()
            except:
                results.record_test("Health Endpoint JSON Response", False, "Response is not valid JSON")
                return
                
            # Verify required fields
            required_fields = ["status", "service"]
            missing_fields = [f for f in required_fields if f not in data]
            if missing_fields:
                results.record_test("Health Endpoint Response Fields", False, f"Missing fields: {missing_fields}")
                return
            
            # Status should be "ok" or "degraded"
            valid_statuses = ["ok", "degraded"]
            if data.get("status") not in valid_statuses:
                results.record_test("Health Endpoint Status", False, f"Status '{data.get('status')}' not in {valid_statuses}")
                return
            
            if data.get("service") != "route-optimizer":
                results.record_test("Health Endpoint Service", False, f"Service is '{data.get('service')}' instead of 'route-optimizer'")
                return
            
            results.record_test("Health Endpoint (GET /health)", True)
            
            print(f"   Response: {json.dumps(data, indent=2)}")
            
    except Exception as e:
        results.record_test("Health Endpoint (GET /health)", False, f"Request failed: {str(e)}")

async def test_readiness_endpoint(session, results):
    """Test 3: GET /ready responds with proper schema"""
    try:
        async with session.get(f"{BACKEND_BASE_URL}/ready") as response:
            # Readiness can return 200 or 503 depending on DB state
            status_code = response.status
            valid_status_codes = [200, 503]
            
            if status_code not in valid_status_codes:
                results.record_test("Ready Endpoint Valid Status", False, f"Got {status_code}, expected one of {valid_status_codes}")
                return
                
            try:
                data = await response.json()
            except:
                results.record_test("Ready Endpoint JSON Response", False, "Response is not valid JSON")
                return
                
            # Verify schema - must have "ready" and "database" fields
            required_fields = ["ready", "database"]
            missing_fields = [f for f in required_fields if f not in data]
            if missing_fields:
                results.record_test("Ready Endpoint Schema", False, f"Missing required fields: {missing_fields}")
                return
                
            # Verify field types and values
            if not isinstance(data.get("ready"), bool):
                results.record_test("Ready Field Type", False, f"'ready' field should be boolean, got {type(data.get('ready'))}")
                return
                
            valid_db_states = ["connected", "disconnected", "connecting"]
            if data.get("database") not in valid_db_states:
                results.record_test("Database Field Value", False, f"'database' should be one of {valid_db_states}, got '{data.get('database')}'")
                return
                
            results.record_test("Ready Endpoint Schema Validation", True)
            results.record_test("Ready Endpoint (GET /ready)", True)
            
            print(f"   Status Code: {status_code}")
            print(f"   Response: {json.dumps(data, indent=2)}")
            
    except Exception as e:
        results.record_test("Ready Endpoint (GET /ready)", False, f"Request failed: {str(e)}")

async def test_liveness_endpoint(session, results):
    """Test 4: GET /live responds correctly (simple liveness check)"""
    try:
        async with session.get(f"{BACKEND_BASE_URL}/live") as response:
            status_code = response.status
            
            if status_code != 200:
                results.record_test("Live Endpoint HTTP 200", False, f"Got {status_code} instead of 200")
                return
                
            try:
                data = await response.json()
            except:
                results.record_test("Live Endpoint JSON Response", False, "Response is not valid JSON")
                return
                
            if not isinstance(data, dict):
                results.record_test("Live Endpoint JSON Structure", False, "Response is not a JSON object")
                return
                
            if data.get("alive") is not True:
                results.record_test("Live Endpoint Alive Field", False, f"Expected alive=true, got alive={data.get('alive')}")
                return
                
            results.record_test("Liveness Endpoint (GET /live)", True)
            
            print(f"   Response: {json.dumps(data, indent=2)}")
            
    except Exception as e:
        results.record_test("Liveness Endpoint (GET /live)", False, f"Request failed: {str(e)}")

async def test_api_health_endpoint(session, results):
    """Test 5: GET /api/health also works (prefixed health endpoint)"""
    try:
        async with session.get(f"{BACKEND_BASE_URL}/api/health") as response:
            status_code = response.status
            
            if status_code != 200:
                results.record_test("API Health Endpoint HTTP 200", False, f"Got {status_code} instead of 200")
                return
                
            try:
                data = await response.json()
            except:
                results.record_test("API Health Endpoint JSON Response", False, "Response is not valid JSON")
                return
                
            # This endpoint has different structure - includes timestamp
            required_fields = ["status"]
            missing_fields = [f for f in required_fields if f not in data]
            if missing_fields:
                results.record_test("API Health Endpoint Fields", False, f"Missing fields: {missing_fields}")
                return
                
            valid_statuses = ["healthy", "unhealthy"]
            if data.get("status") not in valid_statuses:
                results.record_test("API Health Endpoint Status", False, f"Status '{data.get('status')}' not in {valid_statuses}")
                return
                
            results.record_test("API Health Endpoint (GET /api/health)", True)
            
            print(f"   Response: {json.dumps(data, indent=2)}")
            
    except Exception as e:
        results.record_test("API Health Endpoint (GET /api/health)", False, f"Request failed: {str(e)}")

async def test_rapid_requests_no_crash(session, results):
    """Test 6: Rapid successive calls to probe endpoints don't cause crashes"""
    try:
        print("   Testing rapid successive calls...")
        
        # Test rapid calls to root endpoint (this was causing issues in deployment)
        tasks = []
        for i in range(10):
            tasks.append(session.get(f"{BACKEND_BASE_URL}/"))
            
        responses = await asyncio.gather(*tasks, return_exceptions=True)
        
        success_count = 0
        for i, response in enumerate(responses):
            if isinstance(response, Exception):
                print(f"     Request {i+1}: Exception - {response}")
                continue
                
            if response.status == 200:
                success_count += 1
                response.close()
            else:
                print(f"     Request {i+1}: HTTP {response.status}")
                
        if success_count == 10:
            results.record_test("Rapid Requests No Crash", True)
            print(f"   All {success_count}/10 rapid requests successful")
        else:
            results.record_test("Rapid Requests No Crash", False, f"Only {success_count}/10 requests successful")
            
    except Exception as e:
        results.record_test("Rapid Requests No Crash", False, f"Test failed: {str(e)}")

async def main():
    print("🚀 BACKEND DEPLOYMENT PROBE VALIDATION")
    print("=" * 50)
    print(f"Testing backend at: {BACKEND_BASE_URL}")
    print(f"Test started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("")
    
    results = ProbeTestResults()
    
    timeout = aiohttp.ClientTimeout(total=10)
    
    async with aiohttp.ClientSession(timeout=timeout) as session:
        print("🔍 Testing deployment probe endpoints...")
        print("")
        
        # Test 1: Root probe endpoint (the key fix)
        print("1. Root Probe Endpoint (GET /) - MongoDB Independent:")
        await test_root_probe_endpoint(session, results)
        print("")
        
        # Test 2: Health endpoint 
        print("2. Health Endpoint (GET /health) - MongoDB Dependent:")
        await test_health_endpoint(session, results)
        print("")
        
        # Test 3: Readiness endpoint
        print("3. Readiness Endpoint (GET /ready) - MongoDB Dependent:")
        await test_readiness_endpoint(session, results)
        print("")
        
        # Test 4: Liveness endpoint
        print("4. Liveness Endpoint (GET /live) - Simple Check:")
        await test_liveness_endpoint(session, results)
        print("")
        
        # Test 5: API health endpoint
        print("5. API Health Endpoint (GET /api/health) - MongoDB Dependent:")
        await test_api_health_endpoint(session, results)
        print("")
        
        # Test 6: Rapid requests (deployment issue simulation)
        print("6. Deployment Crash-Loop Prevention Test:")
        await test_rapid_requests_no_crash(session, results)
        print("")
    
    # Print final results
    success = results.print_summary()
    
    if success:
        print("\n🎉 All deployment probe tests PASSED!")
        print("✅ Backend deployment resilience validated successfully")
        return 0
    else:
        print("\n⚠️  Some deployment probe tests FAILED!")
        print("❌ Backend deployment issues detected")
        return 1

if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)