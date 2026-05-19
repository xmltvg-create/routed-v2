#!/usr/bin/env python3
"""
Backend Health Endpoint Test Suite
Tests MongoDB timeout handling and deployment resilience endpoints
"""
import requests
import json
import time
import sys
import traceback
from urllib.parse import urlparse

# Use localhost internal port as specified in review request
BACKEND_BASE_URL = "http://127.0.0.1:8001"

def test_health_endpoints():
    """Test the three health/readiness/liveness endpoints"""
    
    print("\n=== BACKEND DEPLOYMENT RESILIENCE TESTING ===")
    print(f"Testing backend at: {BACKEND_BASE_URL}")
    print("-" * 60)
    
    results = {
        "live": {"tested": False, "working": False, "details": ""},
        "ready": {"tested": False, "working": False, "details": ""},
        "health": {"tested": False, "working": False, "details": ""},
        "schema_validation": {"tested": False, "working": False, "details": ""},
        "crash_loop_check": {"tested": False, "working": False, "details": ""}
    }
    
    # Test 1: Liveness endpoint
    print("1. Testing GET /live endpoint...")
    try:
        response = requests.get(f"{BACKEND_BASE_URL}/live", timeout=10)
        results["live"]["tested"] = True
        
        if response.status_code == 200:
            data = response.json()
            print(f"   ✅ Status: {response.status_code}")
            print(f"   ✅ Response: {json.dumps(data, indent=2)}")
            
            if "alive" in data:
                results["live"]["working"] = True
                results["live"]["details"] = f"Returns 200 with alive={data['alive']}"
            else:
                results["live"]["details"] = "Missing 'alive' key in response"
        else:
            print(f"   ❌ Status: {response.status_code}")
            print(f"   ❌ Response: {response.text}")
            results["live"]["details"] = f"HTTP {response.status_code}: {response.text}"
            
    except Exception as e:
        print(f"   ❌ Error: {str(e)}")
        results["live"]["details"] = f"Request failed: {str(e)}"
    
    # Test 2: Readiness endpoint  
    print("\n2. Testing GET /ready endpoint...")
    try:
        response = requests.get(f"{BACKEND_BASE_URL}/ready", timeout=10)
        results["ready"]["tested"] = True
        
        print(f"   Status: {response.status_code}")
        data = response.json()
        print(f"   Response: {json.dumps(data, indent=2)}")
        
        if response.status_code == 200:
            if "ready" in data and "database" in data:
                if data.get("ready") is True and data.get("database") == "connected":
                    results["ready"]["working"] = True
                    results["ready"]["details"] = "Returns 200 with ready=true and database=connected"
                    print("   ✅ Ready endpoint working correctly")
                else:
                    results["ready"]["details"] = f"Ready state: ready={data.get('ready')}, database={data.get('database')}"
                    print(f"   ⚠️  Ready but not fully connected: {results['ready']['details']}")
            else:
                results["ready"]["details"] = "Missing required 'ready' or 'database' keys"
                print(f"   ❌ Schema issue: {results['ready']['details']}")
        else:
            results["ready"]["details"] = f"HTTP {response.status_code}: {response.text}"
            print(f"   ❌ Non-200 status: {results['ready']['details']}")
            
    except Exception as e:
        print(f"   ❌ Error: {str(e)}")
        results["ready"]["details"] = f"Request failed: {str(e)}"
    
    # Test 3: Health endpoint
    print("\n3. Testing GET /health endpoint...")
    try:
        response = requests.get(f"{BACKEND_BASE_URL}/health", timeout=10)
        results["health"]["tested"] = True
        
        if response.status_code == 200:
            data = response.json()
            print(f"   ✅ Status: {response.status_code}")
            print(f"   ✅ Response: {json.dumps(data, indent=2)}")
            
            if "status" in data:
                results["health"]["working"] = True
                results["health"]["details"] = f"Returns 200 with status={data['status']}"
            else:
                results["health"]["details"] = "Missing 'status' key in response"
        else:
            print(f"   ❌ Status: {response.status_code}")
            print(f"   ❌ Response: {response.text}")
            results["health"]["details"] = f"HTTP {response.status_code}: {response.text}"
            
    except Exception as e:
        print(f"   ❌ Error: {str(e)}")
        results["health"]["details"] = f"Request failed: {str(e)}"
    
    # Test 4: Schema validation for /ready endpoint
    print("\n4. Validating /ready endpoint response schema...")
    try:
        response = requests.get(f"{BACKEND_BASE_URL}/ready", timeout=10)
        results["schema_validation"]["tested"] = True
        
        if response.status_code == 200:
            data = response.json()
            
            # Check required keys
            required_keys = ["ready", "database"]
            missing_keys = [key for key in required_keys if key not in data]
            
            if not missing_keys:
                results["schema_validation"]["working"] = True
                results["schema_validation"]["details"] = "Schema validation passed: contains required 'ready' and 'database' keys"
                print(f"   ✅ Schema valid: {results['schema_validation']['details']}")
            else:
                results["schema_validation"]["details"] = f"Missing required keys: {missing_keys}"
                print(f"   ❌ Schema invalid: {results['schema_validation']['details']}")
        else:
            results["schema_validation"]["details"] = f"Cannot validate schema, endpoint returned {response.status_code}"
            print(f"   ❌ {results['schema_validation']['details']}")
            
    except Exception as e:
        print(f"   ❌ Error: {str(e)}")
        results["schema_validation"]["details"] = f"Schema validation failed: {str(e)}"
    
    # Test 5: Crash-loop behavior check
    print("\n5. Testing for crash-loop behavior (multiple rapid calls)...")
    try:
        results["crash_loop_check"]["tested"] = True
        crash_detected = False
        failed_calls = 0
        total_calls = 10
        
        print(f"   Making {total_calls} rapid calls to /ready endpoint...")
        
        for i in range(total_calls):
            try:
                response = requests.get(f"{BACKEND_BASE_URL}/ready", timeout=5)
                if response.status_code >= 500:
                    failed_calls += 1
                    print(f"   Call {i+1}: HTTP {response.status_code} (server error)")
                else:
                    print(f"   Call {i+1}: HTTP {response.status_code} ✅")
                    
                time.sleep(0.5)  # Small delay between calls
                
            except Exception as e:
                failed_calls += 1
                print(f"   Call {i+1}: Failed - {str(e)}")
        
        if failed_calls == 0:
            results["crash_loop_check"]["working"] = True
            results["crash_loop_check"]["details"] = f"No crash-loop detected: {total_calls}/{total_calls} calls successful"
            print(f"   ✅ {results['crash_loop_check']['details']}")
        elif failed_calls < total_calls / 2:
            results["crash_loop_check"]["working"] = True
            results["crash_loop_check"]["details"] = f"Intermittent issues but no crash-loop: {failed_calls}/{total_calls} calls failed"
            print(f"   ⚠️  {results['crash_loop_check']['details']}")
        else:
            results["crash_loop_check"]["details"] = f"Possible crash-loop detected: {failed_calls}/{total_calls} calls failed"
            print(f"   ❌ {results['crash_loop_check']['details']}")
            
    except Exception as e:
        print(f"   ❌ Error: {str(e)}")
        results["crash_loop_check"]["details"] = f"Crash-loop test failed: {str(e)}"
    
    return results

def print_test_summary(results):
    """Print comprehensive test summary"""
    print("\n" + "=" * 80)
    print("BACKEND DEPLOYMENT RESILIENCE TEST SUMMARY")
    print("=" * 80)
    
    total_tests = len(results)
    passed_tests = sum(1 for r in results.values() if r["working"])
    tested_count = sum(1 for r in results.values() if r["tested"])
    
    print(f"Tests Run: {tested_count}/{total_tests}")
    print(f"Tests Passed: {passed_tests}/{total_tests}")
    print(f"Success Rate: {(passed_tests/total_tests)*100:.1f}%")
    print()
    
    # Detailed results
    status_map = {True: "✅ PASS", False: "❌ FAIL"}
    
    for test_name, result in results.items():
        status = status_map.get(result["working"], "⏸️ NOT RUN")
        print(f"{test_name.upper():<20} {status}")
        if result["details"]:
            print(f"                     └─ {result['details']}")
    
    print("\n" + "=" * 80)
    
    # Critical endpoint analysis
    critical_endpoints = ["live", "ready", "health"]
    critical_passed = sum(1 for name in critical_endpoints if results[name]["working"])
    
    if critical_passed == len(critical_endpoints):
        print("🎉 ALL CRITICAL HEALTH ENDPOINTS WORKING")
        return True
    else:
        print(f"⚠️  CRITICAL ISSUES: {len(critical_endpoints) - critical_passed}/{len(critical_endpoints)} health endpoints failing")
        return False

if __name__ == "__main__":
    print("Starting Backend Health Endpoint Testing...")
    
    try:
        results = test_health_endpoints()
        all_critical_passed = print_test_summary(results)
        
        # Exit with appropriate code
        sys.exit(0 if all_critical_passed else 1)
        
    except KeyboardInterrupt:
        print("\n⚠️ Test interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n💥 Unexpected error during testing: {str(e)}")
        print(traceback.format_exc())
        sys.exit(1)